import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { createAttemptResult, createFinalAssistant } from "./lifecycle.test-support.js";
import {
  EmptySettledTurnFinalizationError,
  RejectedToolCallSettledTurnFinalizationError,
} from "./settled-turn-finalization-outcome.js";
import {
  assertSettledTurnFinalizationResult,
  projectSettledTurnFinalizationAttemptResult,
} from "./settled-turn-finalization-result.js";
import type { AgentHarnessSettledTurnFinalizationResult } from "./types.js";

function safeResult(
  assistant: Partial<AssistantMessage> = {},
): AgentHarnessSettledTurnFinalizationResult {
  return { assistant: { ...createFinalAssistant(), ...assistant } };
}

function successfulAttempt(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const assistant = createFinalAssistant();
  return {
    ...createAttemptResult(),
    diagnosticTrace: undefined,
    messagesSnapshot: [assistant],
    assistantTexts: ["done"],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    ...overrides,
  };
}

it("classifies a normally completed empty rendered answer", () => {
  const result = safeResult({ content: [{ type: "text", text: "  " }] });
  try {
    assertSettledTurnFinalizationResult(result);
    throw new Error("expected completed-empty classification");
  } catch (error) {
    expect(error).toBeInstanceOf(EmptySettledTurnFinalizationError);
    expect((error as EmptySettledTurnFinalizationError).result).toMatchObject(result);
  }
});

it.each<[string, AgentHarnessSettledTurnFinalizationResult]>([
  [
    "returned a tool call",
    safeResult({
      content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
      stopReason: "toolUse",
    }),
  ],
  [
    "unsuccessful stop reason: length",
    safeResult({ content: [{ type: "text", text: "partial" }], stopReason: "length" }),
  ],
  ["invalid assistant message index", { ...safeResult(), assistantMessageIndex: -1 }],
  [
    "unsupported result field: futureCapabilityEvidence",
    {
      ...safeResult(),
      futureCapabilityEvidence: true,
    } as AgentHarnessSettledTurnFinalizationResult,
  ],
])("rejects invalid finals: %s", (error, result) => {
  expect(() => assertSettledTurnFinalizationResult(result)).toThrow(error);
});

it("projects a successful full attempt into the narrow result", () => {
  const attempt = successfulAttempt({ lastAssistantTextMessageIndex: 2 });

  expect(projectSettledTurnFinalizationAttemptResult(attempt)).toMatchObject({
    assistant: attempt.currentAttemptCompletedAssistant,
    assistantMessageIndex: 2,
  });
});

it.each<[Partial<EmbeddedRunAttemptResult>, string]>([
  [{ compactionCount: 1 }, "did not complete successfully"],
  [
    {
      toolMetas: [{ toolName: "write" }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    },
    "reported capability activity",
  ],
  [
    {
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: false },
    },
    "reported capability activity",
  ],
  [{ currentAttemptCompletedAssistant: undefined }, "no completed assistant message"],
])("rejects a full attempt with %j", (overrides, error) => {
  expect(() => projectSettledTurnFinalizationAttemptResult(successfulAttempt(overrides))).toThrow(
    error,
  );
});

describe("after tool calls the tools-disabled pass rejected", () => {
  const rejectedCall: AssistantMessage = {
    ...createFinalAssistant(),
    content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
    stopReason: "toolUse",
  };
  const cleanFinal = (): AssistantMessage => ({
    ...createFinalAssistant(),
    content: [{ type: "text", text: "The clean final answer." }],
  });
  function afterRejectedCall(
    final: AssistantMessage,
    overrides: Partial<EmbeddedRunAttemptResult> = {},
  ): EmbeddedRunAttemptResult {
    return successfulAttempt({
      messagesSnapshot: [rejectedCall, final],
      lastAssistant: final,
      currentAttemptAssistant: final,
      currentAttemptCompletedAssistant: final,
      toolMetas: [{ toolCallId: "call-write", toolName: "write", isError: true }],
      lastToolError: {
        toolName: "write",
        executionStarted: false,
        error: "Tool write not found",
      },
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      // A call that never started leaves the execution-based replay state
      // clean; only the name-based current-attempt marking goes unsafe.
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
      ...overrides,
    });
  }

  it("accepts a later clean final answer instead of reporting capability activity", () => {
    const final = cleanFinal();

    expect(projectSettledTurnFinalizationAttemptResult(afterRejectedCall(final))).toMatchObject({
      assistant: final,
    });
  });

  it("classifies a pass that ended on its rejected tool call for the host's retry", () => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(afterRejectedCall(rejectedCall)),
    ).toThrow(RejectedToolCallSettledTurnFinalizationError);
  });

  it.each<[string, Partial<EmbeddedRunAttemptResult>]>([
    [
      "a tool that started executing",
      { lastToolError: { toolName: "write", executionStarted: true, error: "denied" } },
    ],
    ["a tool that succeeded", { toolMetas: [{ toolName: "write", isError: false }] }],
    [
      "an executed side effect",
      { replayMetadata: { hadPotentialSideEffects: true, replaySafe: false } },
    ],
    [
      "a tool still running",
      { itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } },
    ],
    ["a message send", { didSendViaMessagingTool: true, messagingToolSentTexts: ["sent"] }],
  ])("still reports capability activity for %s", (_name, overrides) => {
    expect(() =>
      projectSettledTurnFinalizationAttemptResult(afterRejectedCall(cleanFinal(), overrides)),
    ).toThrow("reported capability activity");
  });
});
