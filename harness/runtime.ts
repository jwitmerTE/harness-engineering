import { DBOS } from "@dbos-inc/dbos-sdk";
import { streamText } from "ai";
import type { ModelMessage, JSONValue, ToolSet } from "ai";
import { EventType } from "@shared/events";
import { emit } from "./bus";
import { model } from "./model";
import { runTool } from "./tools";
import { triageAgent, agents } from "./agents";
import {
  buildContext,
  summarize,
  estimateTokens,
  MAX_CONTEXT_TOKENS,
  KEEP_CONTEXT_TOKENS,
} from "./memory";

const MAX_STEPS = 30;

// Tools that require a human's go-ahead before they run. (Just the irreversible
// one for now — the billing agent's refund.)
const NEEDS_APPROVAL = new Set(["issueRefund"]);
const APPROVAL_TIMEOUT_S = 86_400; // up to a day — a human approval is an unbounded wait

type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
type Turn = { text: string; toolCalls: ToolCall[]; responseMessages: ModelMessage[] };

// One model turn over the hydrated context, using the CURRENT agent's tools.
async function modelTurn(
  workflowId: string,
  context: ModelMessage[],
  agentTools: ToolSet,
): Promise<Turn> {
  const result = streamText({ model, messages: context, tools: agentTools });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      await emit({ type: EventType.ModelDelta, workflowId, text: part.text });
    }
  }

  const rawCalls = await result.toolCalls;
  return {
    text: await result.text,
    toolCalls: rawCalls.map((c) => ({
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: c.input as Record<string, unknown>,
    })),
    responseMessages: (await result.response).messages,
  };
}

// Execute one tool. Run as a DBOS step so its side effect runs exactly once.
async function toolStep(workflowId: string, call: ToolCall): Promise<Record<string, unknown>> {
  await emit({
    type: EventType.ToolRequested,
    workflowId,
    toolCallId: call.toolCallId,
    name: call.toolName,
    args: call.input,
  });
  const output = await runTool(call.toolName, call.input);
  await emit({
    type: EventType.ToolCompleted,
    workflowId,
    toolCallId: call.toolCallId,
    result: output,
  });
  return output;
}

function toolResultMessage(call: ToolCall, value: JSONValue): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "json", value } },
    ],
  };
}

// THE DURABLE AGENT LOOP — now a general RUNTIME that runs any agent.
//
// The loop is identical to before, with two additions:
//   · it runs the CURRENT agent's prompt + tools (start: triage)
//   · the `handoff` tool isn't executed — the harness intercepts it and SWITCHES
//     the running agent, keeping the conversation. Control transfers laterally.
//
// `currentAgent` is rebuilt deterministically on recovery (the handoff is a
// consequence of a cached model decision), so this composes with durability.
async function agentWorkflow(input: string): Promise<string> {
  const workflowId = DBOS.workflowID ?? "unknown";
  await DBOS.runStep(
    () => emit({ type: EventType.WorkflowStarted, workflowId, input }),
    { name: "started" },
  );

  let currentAgent = triageAgent;
  const turns: ModelMessage[][] = [];
  let summary = "";

  let step = 0;
  while (step < MAX_STEPS) {
    // 1. Compact old turns once the window is over budget.
    if (estimateTokens(turns.flat()) > MAX_CONTEXT_TOKENS) {
      const old: ModelMessage[][] = [];
      while (turns.length > 1 && estimateTokens(turns.flat()) > KEEP_CONTEXT_TOKENS) {
        const oldest = turns.shift();
        if (oldest) old.push(oldest);
      }
      if (old.length > 0) {
        summary = await DBOS.runStep(() => summarize(old, summary), { name: `summarize-${step}` });
        const contextTokens = estimateTokens(
          buildContext(currentAgent.systemPrompt, input, summary, turns),
        );
        await DBOS.runStep(
          () =>
            emit({
              type: EventType.MemoryCompacted,
              workflowId,
              summarizedTurns: old.length,
              contextTokens,
              summary,
            }),
          { name: `compacted-${step}` },
        );
      }
    }

    // 2 + 3. Hydrate the CURRENT agent's context and run one turn over it.
    const context = buildContext(currentAgent.systemPrompt, input, summary, turns);
    const turn = await DBOS.runStep(() => modelTurn(workflowId, context, currentAgent.tools), {
      name: `model-${step}`,
    });

    const turnMessages: ModelMessage[] = [...turn.responseMessages];

    if (turn.toolCalls.length === 0) {
      await DBOS.runStep(
        () => emit({ type: EventType.ModelCompleted, workflowId, text: turn.text }),
        { name: `model-done-${step}` },
      );
      await DBOS.runStep(
        () => emit({ type: EventType.WorkflowCompleted, workflowId, output: turn.text }),
        { name: "completed" },
      );
      return turn.text;
    }

    for (const call of turn.toolCalls) {
      if (call.toolName === "handoff") {
        // The harness intercepts handoff: switch the running agent, don't run a tool.
        const to = String(call.input.to ?? "");
        const reason = String(call.input.reason ?? "");
        const from = currentAgent.name;
        await DBOS.runStep(
          () => emit({ type: EventType.AgentHandoff, workflowId, from, to, reason }),
          { name: `handoff-${call.toolCallId}` },
        );
        currentAgent = agents[to] ?? currentAgent;
        turnMessages.push(
          toolResultMessage(call, {
            ok: true,
            message: `You are now the ${to} specialist. Take over and FINISH the task by calling the tools you need — do the work, don't just acknowledge the handoff.`,
          }),
        );
      } else if (NEEDS_APPROVAL.has(call.toolName)) {
        // HUMAN-IN-THE-LOOP. Ask, then SUSPEND the (durable) workflow until a
        // human decides. recv() can wait minutes or days — and because the
        // workflow is durable, the process can crash and resume right here.
        await DBOS.runStep(
          () =>
            emit({
              type: EventType.ApprovalRequested,
              workflowId,
              toolCallId: call.toolCallId,
              action: call.toolName,
              args: call.input,
            }),
          { name: `approval-req-${call.toolCallId}` },
        );

        const decision = await DBOS.recv<{ approved: boolean }>("approval", APPROVAL_TIMEOUT_S);
        const approved = decision?.approved ?? false;

        await DBOS.runStep(
          () =>
            emit({ type: EventType.ApprovalResolved, workflowId, toolCallId: call.toolCallId, approved }),
          { name: `approval-res-${call.toolCallId}` },
        );

        if (approved) {
          const output = await DBOS.runStep(() => toolStep(workflowId, call), {
            name: `tool-${call.toolCallId}`,
          });
          turnMessages.push(toolResultMessage(call, output as JSONValue));
        } else {
          turnMessages.push(
            toolResultMessage(call, {
              approved: false,
              message:
                "A human did NOT approve this action. Do not retry — tell the customer it needs manual review.",
            }),
          );
        }
      } else {
        const output = await DBOS.runStep(() => toolStep(workflowId, call), {
          name: `tool-${call.toolCallId}`,
        });
        turnMessages.push(toolResultMessage(call, output as JSONValue));
      }
    }

    turns.push(turnMessages);
    step++;
  }

  await DBOS.runStep(
    () =>
      emit({
        type: EventType.WorkflowFailed,
        workflowId,
        error: `Hit the ${MAX_STEPS}-step limit without finishing.`,
      }),
    { name: "failed" },
  );
  return "";
}

export const runAgentWorkflow = DBOS.registerWorkflow(agentWorkflow, {
  name: "agentWorkflow",
});
