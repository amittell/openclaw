import { describe, expect, it, vi } from "vitest";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "Your turn ended without a final reply. Continue from the current conversation and answer the user's request now. Do not repeat completed actions or restart the task. Do not restate your reasoning.";

// A subagent lane resolves to the "result-required" reply expectation, so the retry half is
// upstream's; only the exhausted turn's fallback safety is the fork's (#155000 port).
describe("terminal resolution, subagent reasoning-only retry", () => {
  it("retries a reasoning-only subagent turn and hands the exhausted turn to the fallback model", async () => {
    // Regression: run ad43ead1-b244-4683-8da9-47cbdaa5e5fa (2026-09-21, session
    // agent:main:subagent:bf740eaf) ended a subagent lane with 12,364 reasoning
    // tokens, zero visible text, stopReason=stop, and died with
    // terminalError=non_deliverable_terminal_turn after 13 min of a 2h budget.
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "working through the diff",
          thinkingSignature: JSON.stringify({ id: "rs_subagent", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const retryInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: { lane: AGENT_LANE_SUBAGENT },
      sessionPromptState: { activateInternalPrompt },
    });

    await expect(resolveEmbeddedRunTerminal(retryInput)).resolves.toEqual({ action: "retry" });
    expect(retryInput.retryState.reasoningOnlyAttempts).toBe(1);
    expect(activateInternalPrompt).toHaveBeenCalledWith(REASONING_ONLY_RETRY_INSTRUCTION);

    // FORK DIVERGENCE (#155000 port): after the bounded retry budget is spent, a
    // replay-safe subagent turn is fallback-safe even though it stopped normally,
    // and the retained tool presentation rides along with the error.
    const exhaustedInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      retryState: { ...createEmbeddedRunTerminalRetryState(), reasoningOnlyAttempts: 2 },
      readTerminalToolPresentation: () =>
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      runParams: { lane: AGENT_LANE_SUBAGENT },
    });
    const exhausted = await resolveEmbeddedRunTerminal(exhaustedInput);

    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: true,
      terminalPresentation: true,
    });
  });
});
