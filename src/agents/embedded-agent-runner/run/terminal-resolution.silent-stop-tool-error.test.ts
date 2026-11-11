import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { SILENT_STOP_DELIVERY_RETRY_INSTRUCTION } from "./incomplete-turn-recovery.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

// mock-isolation: auth bookkeeping is unrelated to the terminal delivery contract.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

// Fork carry (Alex, 2026-11-11): since #182458 a failed tool is no longer terminal state, so the silent-stop nudge
// now also reaches a message_tool_only turn whose tool failed but whose composed answer was never sent. That answer
// is retried through the message tool alone. With only commentary, #182458's failure warning still completes first.
describe("silent-stop nudge after a failed tool", () => {
  it.each([
    { output: "answer", action: "retry" },
    { output: "commentary", action: "complete" },
  ] as const)(
    "message_tool_only with a failed tool and $output -> $action",
    async ({ output, action }) => {
      const text =
        output === "answer"
          ? "The command was denied; the file was read successfully."
          : "I will check the command and file.";
      const toolCalls = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          ...(output === "commentary" ? [{ type: "text" as const, text }] : []),
          { type: "toolCall", id: "denied", name: "bash", arguments: {} },
        ],
      });
      const assistant = buildEmbeddedRunnerAssistant({
        content: output === "answer" ? [{ type: "text", text }] : [],
      });
      const input = makeTerminalInput({
        attemptAssistant: assistant,
        runParams: { sourceReplyDeliveryMode: "message_tool_only" },
        attempt: makeEmbeddedRunnerAttempt({
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          assistantTexts: [text],
          messageToolCallable: true,
          lastToolError: {
            toolName: "bash",
            error: "codex native tool blocked",
            executionStarted: false,
            mutatingAction: false,
          },
          toolMetas: [{ toolName: "bash", toolCallId: "denied", isError: true, replaySafe: true }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            { role: "user", content: "Run the command and read the file.", timestamp: 0 },
            toolCalls,
            makeTextToolResult("denied", "bash", "Execution denied.", true, 0),
            assistant,
          ],
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        }),
      });
      input.prepared = await prepareAttempt({
        attempt: input.attempt,
        currentAttemptCompletedAssistant: assistant,
        terminalState: input.terminalState,
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe(action);
      expect(vi.mocked(input.sessionPromptState.activateInternalPrompt).mock.calls).toEqual(
        action === "retry"
          ? [[SILENT_STOP_DELIVERY_RETRY_INSTRUCTION, { retryToolsAllow: ["message"] }]]
          : [],
      );
      if (resolved.action === "complete") {
        expect(resolved.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
      }
    },
  );
});
