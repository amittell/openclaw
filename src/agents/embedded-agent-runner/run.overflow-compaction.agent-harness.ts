/**
 * Mocked Codex plugin harness registered by the embedded-run overflow compaction harness.
 */

import { clearAgentHarnesses, registerAgentHarness } from "../harness/registry.js";
import type { AgentHarnessAttemptParams } from "../harness/types.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

/** Replaces every registered harness with a Codex harness that runs `runAttempt`. */
export function resetMockCodexAgentHarness(
  runAttempt: (params: AgentHarnessAttemptParams) => Promise<EmbeddedRunAttemptResult>,
): void {
  clearAgentHarnesses();
  registerAgentHarness({
    id: "codex",
    label: "Codex",
    // Like the bundled Codex harness, this fixture enforces a restricted tool set.
    conversationToolPolicySupport: "exact",
    supports: (ctx) =>
      ctx.provider === "codex" || ctx.provider === "openai"
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async (params) => await runAttempt(params),
    finalizeSettledTurn: async ({ attempt }) => {
      const result = await runAttempt({ ...attempt, disableTools: true });
      const assistant =
        result.currentAttemptCompletedAssistant ??
        result.currentAttemptAssistant ??
        result.lastAssistant;
      if (!assistant) {
        throw new Error("mocked settled-turn finalization returned no assistant message");
      }
      return { assistant, ...(result.attemptUsage ? { usage: result.attemptUsage } : {}) };
    },
  });
}
