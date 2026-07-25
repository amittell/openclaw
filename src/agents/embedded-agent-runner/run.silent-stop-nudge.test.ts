// Silent-stop delivery nudge coverage (re-anchored from the deleted
// run.incomplete-turn.test.ts e2e harness; upstream #123114/#123022 moved the
// incomplete-turn runner to owners, so these integration tests now load the
// shared run harness like the other full-entry runner tests).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import { SILENT_STOP_DELIVERY_RETRY_INSTRUCTION } from "./run/incomplete-turn-recovery.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function textEndTurnAttempt(text: string, extra: Partial<EmbeddedRunAttemptResult> = {}) {
  const lastAssistant = {
    role: "assistant",
    stopReason: "end_turn",
    provider: "gpufarm",
    model: "qwen3.6-27b",
    content: [{ type: "text", text }],
  } as unknown as EmbeddedRunAttemptResult["lastAssistant"];
  return makeAttemptResult({
    assistantTexts: [text],
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    ...extra,
  });
}

function runAttemptCall(index: number): { prompt?: string } {
  const call = mockedRunEmbeddedAttempt.mock.calls[index];
  if (!call) {
    throw new Error(`Expected run embedded attempt call ${index}`);
  }
  return call[0] as { prompt?: string };
}

describe("runEmbeddedAgent silent-stop delivery nudge", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("nudges one delivery continuation when message_tool_only text was never sent", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      textEndTurnAttempt("Here is the status summary you asked for."),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      textEndTurnAttempt("Sent.", {
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [{ text: "Status summary" }],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sourceReplyDeliveryMode: "message_tool_only",
      provider: "gpufarm",
      model: "qwen3.6-27b",
      runId: "run-silent-stop-nudge",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(SILENT_STOP_DELIVERY_RETRY_INSTRUCTION);
  });

  it("accepts the turn without nudging when message_tool_only delivery happened", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      textEndTurnAttempt("Done — sent the summary.", {
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [{ text: "the summary" }],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sourceReplyDeliveryMode: "message_tool_only",
      provider: "gpufarm",
      model: "qwen3.6-27b",
      runId: "run-silent-stop-delivered",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const onlyCall = runAttemptCall(0);
    expect(onlyCall.prompt).not.toContain(SILENT_STOP_DELIVERY_RETRY_INSTRUCTION);
  });

  it("gives up after one silent-stop nudge instead of looping", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      textEndTurnAttempt("I looked into it and everything is fine."),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      textEndTurnAttempt("I looked into it and everything is fine."),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      sourceReplyDeliveryMode: "message_tool_only",
      provider: "gpufarm",
      model: "qwen3.6-27b",
      runId: "run-silent-stop-bounded",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
