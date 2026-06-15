# Harness Engineering — System Overview

**Stack:** Node.js + TypeScript, Vercel AI SDK, OpenAI, DBOS (durable execution), Drizzle + Postgres.

---

## What this is

A bare LLM loop fails in production in predictable ways: a crash loses everything, a tool fires twice, context grows until the model degrades, a human approval stalls for days. This project is a **mini agent runtime** — called the harness — that handles all of it. The domain is intentionally ordinary (support triage). The runtime is the point.

> Agent systems are workflow systems. The LLM decides the next semantic step. The harness owns execution.

The harness is not a framework. It's a set of composable modules — each one responsible for exactly one concern — that together make an agent loop production-grade.

---

## Key dependencies

**DBOS** (`@dbos-inc/dbos-sdk`) provides durable execution. Wrapping a function in `DBOS.runStep()` checkpoints its result to Postgres before the workflow continues. If the process crashes mid-run, `DBOS.launch()` on the next startup finds every in-flight workflow and resumes each one from its last completed step — no repeated LLM calls, no duplicate side effects. `DBOS.recv()` and `DBOS.send()` extend the same guarantee to inter-workflow messaging, which is how human-approval suspend/resume works. In production, Temporal and Inngest cover the same ground with different hosting models.

**Drizzle** (`drizzle-orm`) is a type-safe SQL query builder. It's used here specifically for the `event_log` table, where the `data` column is typed as `AgentEvent` — so every row you read back from Postgres is already the right shape, no runtime casting. Raw SQL would work; Drizzle earns its place through that single column type.

---

## The execution loop

Everything in this codebase contributes to one durable execution loop:

```ts
async function agentWorkflow(input: string) {
  while (step < MAX_STEPS) {
    const context = buildContext(agent.systemPrompt, input, summary, turns); // memory
    const turn    = await DBOS.runStep(() => modelTurn(context, agent.tools)); // durable LLM call
    for (const call of turn.toolCalls) {
      if (call.toolName === "handoff") { currentAgent = agents[call.input.to]; continue; }
      if (NEEDS_APPROVAL.has(call.toolName)) { await DBOS.recv("approval", timeout); }
      await DBOS.runStep(() => toolStep(call));                                // durable tool call
    }
  }
}
```

Each line in that loop corresponds to a module. The sections below explain how each module works and why it belongs.

---

## The shared contract — `shared/events.ts`

The harness and the inspector UI never share business logic. They share one thing: a typed event stream. Every action the harness takes — model token, tool call, handoff, approval request — becomes an `AgentEvent` emitted onto this stream. The inspector renders the stream; it never talks to the model or the tools directly.

```ts
export enum EventType {
  WorkflowStarted, WorkflowCompleted, WorkflowFailed,
  ModelDelta, ModelCompleted,
  ToolRequested, ToolCompleted, ToolFailed,
  MemoryCompacted,
  AgentHandoff,
  PlanCreated, SubagentStarted, SubagentCompleted, SubagentFailed,
  ApprovalRequested, ApprovalResolved,
  Log,
}
```

This enum is the complete capability list of the harness. Adding a new runtime feature means adding an event type here first. That discipline keeps the harness and the UI in sync without coupling them.

---

## The event bus — `harness/bus.ts`

The bus is the publish/subscribe backbone. It has two jobs: persist every event to Postgres before broadcasting it, and replay the full timeline to a freshly connected inspector.

```ts
export async function emit(input: EventInput): Promise<void> {
  const event = { ...input, id: randomUUID(), ts: Date.now() };
  await db.insert(eventLog).values({ data: event }); // durable write first
  for (const listener of listeners) listener(event); // then broadcast
}

export async function history(): Promise<AgentEvent[]> {
  return (await db.select().from(eventLog).orderBy(eventLog.seq)).map(r => r.data);
}
```

The Postgres write happens before the broadcast intentially; the inspector never sees an event that was not already committed. When a workflow recovers after a crash, the inspector replays from Postgres and shows the complete timeline — including work that happened before the restart.

---

## The database layer — `harness/db.ts`

Drizzle and `postgres.js` with a minimal schema: one table, two columns.

```ts
export const eventLog = pgTable("event_log", {
  seq:  bigserial("seq", { mode: "number" }).primaryKey(), // global insert order
  data: jsonb("data").$type<AgentEvent>().notNull(),       // typed event payload
});
```

`seq` is the only ordering key. Events are never updated, only inserted and read. `ensureSchema()` creates the table on boot so the project runs without a migration step. `clearEventLog()` truncates it and is wired to the inspector's Clear button.

---

## Tools and the executor — `harness/tools.ts`

Tools are defined in two separate concerns: the **schema** (what the model sees) and the **executor** (what the harness runs). The model never calls a tool directly — it returns a structured `toolCall` object; the harness decides whether and how to run it.

The tool set splits into tiers by consequence:

**Read/compute tools** (safe to re-run after a crash):
- `runCode` — the agent writes a JS function body; the harness runs it in the sandbox and returns the result
- `classifyItem`, `draftReply` — pure read or in-memory operations

**Side-effecting tools** (each call is a durable step):
- `sendReply` — actually emails the customer
- `issueRefund` — moves money; also requires human approval before executing

**Routing tool** (intercepted by the runtime, never reaches `runTool`):
- `handoff` — signals the runtime to swap the active agent

The `runTool` function is the harness-owned executor. It resolves tool names to implementations, routes `runCode` through the sandbox, and returns structured output the model can read. The model does not get raw function access — it gets a mediated interface.

---

## The sandbox — `harness/sandbox.ts`

When the agent writes code, it runs in a `node:vm` context, not in the host process.

```ts
const context = vm.createContext({
  tools: api,            // only the read API: getCharges, searchKnowledgeBase
  console: { log: ... }, // captured, not real console
  // no require, process, fs, fetch — the global is the whole contract
});
```

The sandbox returns a structured result either way:

```ts
type SandboxResult =
  | { ok: true;  result: unknown; logs: string[] }
  | { ok: false; error: string;   logs: string[] }
```

A structured error is returned to the model, which can read it, diagnose the bug, and rewrite the program. The model is not blocked by a sandbox failure — it is informed by one.

The read-only constraint on the sandbox API is what makes `runCode` safe to checkpoint as a single durable step. Re-running it after a crash has no side effects.

**Caveat:** `node:vm` is not a true security boundary. Its timeout only interrupts synchronous runaway code; it cannot kill leaked async work. Production systems use throwaway micro-VMs (e2b, Cloudflare Sandbox SDK, Fly, Daytona). The harness owns the boundary; the strength of the boundary is a deployment choice.

---

## Memory and context hydration — `harness/memory.ts`

Three distinct concepts that are easy to conflate:

- **History** — everything that happened. Stored durably in Postgres (the event log). Never passed directly to the model.
- **State** — a running prose summary of older turns. The compacted representation of history the model can use.
- **Context** — what the model actually sees this turn. Assembled fresh every turn from the current agent's prompt, the pinned task, the summary, and only the most recent verbatim turns.

```ts
export function buildContext(
  systemPrompt: string,
  task: string,
  summary: string,
  turns: ModelMessage[][],
): ModelMessage[] {
  return [
    { role: "system",  content: systemPrompt },
    { role: "user",    content: task },                  // goal is pinned, never summarized
    { role: "system",  content: `Summary: ${summary}` }, // compacted older work
    ...turns.flat(),                                     // recent turns verbatim
  ];
}
```

When the context window exceeds `MAX_CONTEXT_TOKENS`, the runtime peels the oldest turns into a `summarize()` call — itself a durable DBOS step — and compacts them into the running summary. The budget is token-based, not turn-count-based. Modern models batch many tool calls into one turn, so turn count is a poor proxy for context size.

The effect: context stays flat regardless of task length. The running summary preserves concrete facts (item IDs, amounts, draft IDs) so the model can finish what it started without seeing the full transcript.

---

## Agent definitions — `harness/agents.ts`

An agent is data, not code.

```ts
export type Agent = {
  name: string;
  systemPrompt: string;
  tools: ToolSet;     // a strict subset of the full tool registry
};
```

The runtime runs any agent through the same durable loop. Adding a specialist is adding an entry to this file, not new machinery.

The current agents:

**`triageAgent`** — the generalist. Has `classifyItem`, `runCode`, `draftReply`, `sendReply`, `handoff`. Does not have `issueRefund`. It can tell a customer a refund is coming; it cannot move money.

**`billingAgent`** — the specialist. Has `runCode`, `issueRefund`, `draftReply`, `sendReply`. Does not have `handoff`. It receives control from triage, verifies the charge independently, and acts.

The least-privilege split is enforced by the tool subset, not by policy. Triage physically cannot call `issueRefund` because the schema it receives does not include it.

---

## The execution loop — `harness/runtime.ts`

This is the spine. It ties every module together into one durable, resumable agent loop.

```ts
async function agentWorkflow(input: string): Promise<string> {
  let currentAgent = triageAgent;

  while (step < MAX_STEPS) {
    // 1. Compact context if over budget
    if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
      summary = await DBOS.runStep(() => summarize(old, summary), { name: `summarize-${step}` });
    }

    // 2. One model turn — durable, streamed
    const turn = await DBOS.runStep(
      () => modelTurn(workflowId, buildContext(currentAgent.systemPrompt, input, summary, turns), currentAgent.tools),
      { name: `turn-${step}` },
    );

    // 3. Execute each tool call
    for (const call of turn.toolCalls) {

      // Routing: swap the agent, keep the conversation
      if (call.toolName === "handoff") {
        currentAgent = agents[call.input.to];
        continue;
      }

      // Approval gate: suspend the workflow until a human decides
      if (NEEDS_APPROVAL.has(call.toolName)) {
        await emit({ type: EventType.ApprovalRequested, ... });
        const decision = await DBOS.recv("approval", APPROVAL_TIMEOUT_S);
        if (!decision?.approved) { /* reject path */ continue; }
      }

      // Execute: side effect runs exactly once
      await DBOS.runStep(() => toolStep(workflowId, call), { name: `tool-${call.toolCallId}` });
    }
  }
}
```

Three patterns compose here:

**Durability** — every model call and every tool call is a DBOS step. On crash and restart, DBOS replays the workflow from the last completed step using cached results. The workflow body is deterministic; all non-determinism lives inside steps.

**Handoff** — the `handoff` tool never reaches `runTool`. The runtime intercepts it, swaps `currentAgent`, and continues. The conversation is uninterrupted; only the active prompt and tool set change. The new agent picks up with full context.

**Approval gate** — `DBOS.recv("approval", timeout)` parks the workflow in Postgres and frees the process. No server resources held. `DBOS.send()` from the approval endpoint wakes the workflow — even across a restart, even after hours. The workflow then either executes the tool or rejects it cleanly.

---

## The supervisor — `harness/supervisor.ts`

An alternative runtime for tasks where independent sub-problems benefit from parallelism and context isolation.

```
submit_task (mode: supervised)
    |
    v
makePlan()         -> structured Plan artifact (persisted as a DBOS step)
    |
    v
Promise.allSettled -> [billing investigator, technical investigator, sales investigator]
    |                  (each runs in its own context window, as a single durable step)
    v
fan-in             -> collect successes, record failures, never abort
    |
    v
synthesize()       -> one reply that addresses all findings; acknowledges any gaps
```

`Promise.allSettled` is deliberate: a failed investigator never crashes the supervisor. The synthesis step is told which areas have findings and which do not; it acknowledges gaps rather than hiding them.

The plan is a first-class structured artifact emitted as a `PlanCreated` event. It is what the inspector renders as the sub-agent tree, and what `synthesize` reads to understand the shape of the task.

A `CHAOS_FAIL` environment variable lets you crash a named investigator reproducibly (`CHAOS_FAIL=technical npm run dev`) to verify that the fan-in and synthesis handle partial results correctly.

---

## Investigators — `harness/investigators.ts`

Read-only sub-agents used by the supervisor. Each investigator has a system prompt, a small tool set with `execute` inline — so the AI SDK runs the tool loop without round-tripping through the harness — and runs as a single durable step.

```ts
export async function runInvestigator(agent: string, objective: string): Promise<string> {
  const { text } = await generateText({
    model,
    system: investigator.systemPrompt,
    prompt: objective,
    tools: investigator.tools,  // execute is inline — no toolStep round-trip
    stopWhen: stepCountIs(5),
  });
  return text;
}
```

Because investigators are read-only, re-running one after a crash is safe — no side effects to duplicate. That is what makes it correct to wrap the entire `runInvestigator` call in one DBOS step.

---

## The server — `server/index.ts`

Express + WebSocket. Three responsibilities:

**Startup** — calls `ensureSchema()` to create the event log table, then `DBOS.launch()` which both initializes DBOS and recovers any workflows that were in flight when the process last died.

**WebSocket** — one connection per inspector. Incoming `submit_task` messages route to either `runAgentWorkflow` or `runSupervisorWorkflow` based on `message.mode`. On connection, the full Postgres event log is replayed to the client so it sees the complete timeline.

**REST** — two endpoints:
- `POST /api/clear` — truncates the event log; the inspector calls this on Clear.
- `POST /api/approve/:workflowId` — delivers a human decision to a suspended workflow via `DBOS.send()`.

---

## The inspector — `web/`

A prebuilt Vite + React dashboard that renders the harness event stream. It never talks to the model or the tools. It renders a step timeline from the event stream: model deltas as they stream in, tool calls with their arguments and results, handoff dividers that show agent transitions, a collapsible sub-agent tree under supervisor runs, memory compaction notices, and an Approve/Reject card on `approval.requested`.

The inspector makes a key property visible: because the harness emits every runtime action as an event, the entire UI can be built as a pure projection of that stream. Nothing is hidden infrastructure.

---

## The scripts

**`scripts/inspect-log.ts`** — reads the event log from Postgres directly, bypassing the WebSocket. Counts events by type and flags any tool call that was requested more than once — a diagnostic for duplicate side effects. Pass `truncate` to wipe the log from the terminal.

**`scripts/test-sandbox.ts`** — drives the sandbox without the agent. Runs four cases: a successful computation, a synchronous infinite loop killed by timeout, `require("fs")` blocked by the absent global, and a bug that returns a structured error. Useful for verifying sandbox behavior in isolation.

---

## How the pieces complete the whole

| Concern | Module | Mechanism |
|---|---|---|
| Persistent event log | `bus.ts`, `db.ts` | Every `emit()` writes to Postgres before broadcasting |
| Crash recovery | `runtime.ts`, DBOS | `DBOS.runStep` checkpoints every LLM call and tool call |
| Exactly-once side effects | `runtime.ts`, DBOS | Idempotent steps + durable replay from last checkpoint |
| Safe code execution | `sandbox.ts`, `tools.ts` | `node:vm` context with explicit, read-only API surface |
| Bounded context | `memory.ts` | Token-budget compaction into a running summary |
| Least-privilege routing | `agents.ts`, `runtime.ts` | Tool subset enforced per agent; `handoff` swaps the active agent |
| Parallel sub-tasks | `supervisor.ts`, `investigators.ts` | `Promise.allSettled` over durable steps; fan-in keeps successes |
| Durable human approval | `runtime.ts`, `server/index.ts`, DBOS | `recv`/`send` suspends and resumes the workflow across crashes |
| Observable runtime | `events.ts`, `bus.ts`, `web/` | Typed event stream; inspector is a pure projection |

Each module is a single, replaceable concern. Swap DBOS for Temporal and only `runtime.ts` changes. Swap `node:vm` for e2b and only `sandbox.ts` changes. The rest composes unchanged.
