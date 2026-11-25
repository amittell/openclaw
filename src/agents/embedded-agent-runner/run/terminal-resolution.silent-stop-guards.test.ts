import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE } from "../../../infra/outbound/deliver-types.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createAttemptCarryover } from "./attempt-result.js";
import { SILENT_STOP_DELIVERY_RETRY_INSTRUCTION } from "./incomplete-turn-recovery.js";
import { prepareAttempt } from "./terminal-preparation.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";

// mock-isolation: auth bookkeeping is unrelated to the terminal delivery contract.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const sendFailed = (errorCode?: string) => ({
  toolName: "message",
  error: "socket hang up",
  executionStarted: true,
  mutatingAction: true,
  ...(errorCode ? { errorCode } : {}),
});

// Fork carry (Alex, 2026-11-24): the nudge is skipped when a failed send may already have reached
// the user, here or in an earlier attempt of the run, and on turns whose prompt invites NO_REPLY.
describe("silent-stop nudge guards", () => {
  it.each([
    { name: "a user turn with undelivered text", nudged: true },
    { name: "a send that failed after it started", lastToolError: sendFailed(), nudged: false },
    {
      name: "a send the platform refused before dispatch",
      lastToolError: sendFailed(PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE),
      nudged: true,
    },
    {
      name: "an earlier attempt's send that may have landed",
      carried: { messageSendMayHaveLanded: true },
      nudged: false,
    },
    {
      name: "an exec-completion wake",
      runParams: { inputProvenance: { kind: "internal_system", sourceTool: "exec" } },
      nudged: false,
    },
    { name: "a system-event turn", runParams: { trigger: "event" }, nudged: false },
  ] as const)("$name -> nudged=$nudged", async (row) => {
    const text = "Done: the report is ready.";
    const toolName = row.lastToolError ? "message" : "read";
    const toolCalls = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call", name: toolName, arguments: {} }],
    });
    const assistant = buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
    const input = makeTerminalInput({
      attemptAssistant: assistant,
      runParams: { sourceReplyDeliveryMode: "message_tool_only", ...row.runParams },
      attempt: makeEmbeddedRunnerAttempt({
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        assistantTexts: [text],
        messageToolCallable: true,
        ...(row.lastToolError ? { lastToolError: row.lastToolError } : {}),
        ...row.carried,
        toolMetas: [
          { toolName, toolCallId: "call", isError: Boolean(row.lastToolError), replaySafe: true },
        ],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
        messagesSnapshot: [
          { role: "user", content: "Write the report and tell me.", timestamp: 0 },
          toolCalls,
          makeTextToolResult(
            "call",
            toolName,
            row.lastToolError ? "socket hang up" : "ok",
            Boolean(row.lastToolError),
            0,
          ),
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

    expect(vi.mocked(input.sessionPromptState.activateInternalPrompt).mock.calls).toEqual(
      row.nudged
        ? [[SILENT_STOP_DELIVERY_RETRY_INSTRUCTION, { retryToolsAllow: ["message"] }]]
        : [],
    );
    expect(resolved.action).toBe(row.nudged ? "retry" : "complete");
  });
});

// Each attempt starts with no tool error, so the fact must ride on the attempts after it.
describe("possibly-landed send carryover", () => {
  it.each([
    { name: "a send that failed after it started", error: sendFailed(), carried: true },
    {
      name: "a send refused before dispatch",
      error: sendFailed(PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE),
      carried: undefined,
    },
  ])("$name -> carried=$carried", ({ error, carried }) => {
    const carryover = createAttemptCarryover();
    const failed = makeEmbeddedRunnerAttempt({ lastToolError: error });
    const later = makeEmbeddedRunnerAttempt({});
    carryover.apply(failed);
    carryover.apply(later);
    expect(later.messageSendMayHaveLanded).toBe(carried);
  });
});

// Fork carry: a sessions_send target answers its caller inline (e665daaf0e3), and the delivery
// retry needs a message-only tool surface the harness enforces (0117ea5b64f).
describe("silent-stop nudge delivery conditions", () => {
  it.each([
    ["sessions_send", "complete"],
    ["subagent_announce", "retry"],
  ] as const)(
    "nudges undelivered message_tool_only text unless a %s target answers inline",
    async (sourceTool, action) => {
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "QA-VISIBLE-CHILD-OK" }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["QA-VISIBLE-CHILD-OK"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      });
      const activateInternalPrompt = vi.fn();
      const input = makeTerminalInput({
        attempt,
        attemptAssistant: assistant,
        runParams: {
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: { kind: "inter_session", sourceTool },
        },
        sessionPromptState: { activateInternalPrompt },
      });

      const resolved = await resolveEmbeddedRunTerminal(input);

      expect(resolved.action).toBe(action);
      expect(activateInternalPrompt.mock.calls).toEqual(
        action === "retry"
          ? [[SILENT_STOP_DELIVERY_RETRY_INSTRUCTION, { retryToolsAllow: ["message"] }]]
          : [],
      );
    },
  );

  it.each([
    { messageToolCallable: true, toolsAllow: undefined, harnessEnforces: true, nudged: true },
    // A harness that does not report its tool surface falls back to the runtime allowlist.
    { messageToolCallable: undefined, toolsAllow: undefined, harnessEnforces: true, nudged: true },
    { messageToolCallable: undefined, toolsAllow: ["read"], harnessEnforces: true, nudged: false },
    // Without a callable message tool the final text is private by design.
    { messageToolCallable: false, toolsAllow: undefined, harnessEnforces: true, nudged: false },
    { messageToolCallable: true, toolsAllow: undefined, harnessEnforces: false, nudged: false },
  ])(
    "retries undelivered text with only the message tool: callable $messageToolCallable, allow $toolsAllow, harness enforces $harnessEnforces",
    async ({ messageToolCallable, toolsAllow, harnessEnforces, nudged }) => {
      const assistant = buildEmbeddedRunnerAssistant({
        content: [{ type: "text", text: "Undelivered answer" }],
      });
      const attempt = makeEmbeddedRunnerAttempt({
        assistantTexts: ["Undelivered answer"],
        lastAssistant: assistant,
        currentAttemptAssistant: assistant,
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        ...(messageToolCallable === undefined ? {} : { messageToolCallable }),
      });
      const activateInternalPrompt = vi.fn();
      const resolved = await resolveEmbeddedRunTerminal(
        makeTerminalInput({
          attempt,
          attemptAssistant: assistant,
          runParams: { sourceReplyDeliveryMode: "message_tool_only", toolsAllow },
          sessionPromptState: { activateInternalPrompt },
          harnessEnforcesToolPolicy: harnessEnforces,
        }),
      );

      expect(resolved.action).toBe(nudged ? "retry" : "complete");
      expect(activateInternalPrompt.mock.calls).toEqual(
        nudged ? [[SILENT_STOP_DELIVERY_RETRY_INSTRUCTION, { retryToolsAllow: ["message"] }]] : [],
      );
    },
  );
});
