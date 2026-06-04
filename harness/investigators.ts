import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { model } from "./model";
import { CHARGES, searchKB } from "./tools";

// Sub-agents are read-only INVESTIGATORS. Their tools have `execute`, so the AI
// SDK runs the tool loop inline and each sub-agent is one bounded interaction we
// can run as a single durable step. Read-only → a re-run on recovery is safe.
const getCharges = tool({
  description: "Look up a customer's charges.",
  inputSchema: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => CHARGES[customerId] ?? [],
});

const searchKnowledgeBase = tool({
  description: "Search the support knowledge base.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => searchKB(query),
});

type Investigator = { systemPrompt: string; tools: ToolSet };

const INVESTIGATORS: Record<string, Investigator> = {
  billing: {
    systemPrompt:
      "You are a billing investigator. Use getCharges to find duplicate or erroneous charges. Report the charge ids, the amount, and the refund you'd recommend — concisely.",
    tools: { getCharges },
  },
  technical: {
    systemPrompt:
      "You are a technical investigator. Use searchKnowledgeBase to find known bugs and workarounds. Report the issue, any ticket, and the workaround — concisely.",
    tools: { searchKnowledgeBase },
  },
  sales: {
    systemPrompt:
      "You are a sales investigator. Use searchKnowledgeBase for pricing guidance, then state the relevant numbers and next step — concisely.",
    tools: { searchKnowledgeBase },
  },
};

// Run one investigator over its objective in its OWN context. Returns findings.
export async function runInvestigator(agent: string, objective: string): Promise<string> {
  // A chaos hook so the failure-handling demo is reproducible:
  // CHAOS_FAIL=technical npm run dev  → the technical investigator always fails.
  if (process.env.CHAOS_FAIL === agent) {
    throw new Error(`investigator '${agent}' crashed (CHAOS_FAIL)`);
  }

  const investigator = INVESTIGATORS[agent];
  if (!investigator) throw new Error(`unknown investigator: ${agent}`);

  const { text } = await generateText({
    model,
    system: investigator.systemPrompt,
    prompt: objective,
    tools: investigator.tools,
    stopWhen: stepCountIs(5),
  });
  return text;
}
