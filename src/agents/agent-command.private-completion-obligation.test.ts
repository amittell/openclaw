// Reproduction for openclaw issue #173650: a `completionTarget: "parent"` private
// completion turn composes the owed relay as its final assistant text, commits it to
// the transcript, and ends without sending through the message tool, so the user
// never receives it. This test drives the real requester completion path
// (agentCommandFromGatewayIngress) with an outstanding user-reply obligation
// (pendingFinalDelivery) and captures the four boundary states that prove the
// obligation is retained by construction — the shipped failure was model
// follow-through, not lost boundary state.
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { RUNTIME_EVENT_USER_PROMPT } from "./internal-runtime-context.js";
import { taskCompletionEvents } from "./subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION } from "./subagents/completion/subagent-completion-instructions.js";

registerAgentCommandCompactionTestHooks();

beforeEach(() => {
  if (!state.cfg) {
    throw new Error("missing compaction fixture config");
  }
  setRuntimeConfigSnapshot(state.cfg);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

it("retains an outstanding user-reply obligation across a transcript-only private completion", async () => {
  const sessionKey = "agent:main:telegram:direct:173650";
  const sessionId = "requester-session-173650";
  const storePath = requireCompactionStorePath();
  const target = { agentId: "main", sessionKey, storePath };
  const owedContext = { channel: "telegram", to: "direct:173650" };

  // Seed the outstanding user-reply obligation on the requester entry. This is the
  // durable record that a user-visible final was owed and not yet sent.
  await compactionTestRuntime.replaceSessionEntry(target, {
    sessionId,
    updatedAt: 1,
    pendingFinalDelivery: {
      kind: "replayable",
      text: "Owed user reply",
      intentId: "owed-intent-1",
      deliveries: [{ id: "owed-delivery-1", state: "prepared" }],
      createdAt: 1,
      context: owedContext,
    },
  });

  // (c) before: the obligation is present on the requester entry.
  const before = compactionTestRuntime.loadSessionEntry(target);
  expect(before?.pendingFinalDelivery).toMatchObject({
    intentId: "owed-intent-1",
    deliveries: [{ id: "owed-delivery-1", state: "prepared" }],
  });

  // The private completion turn's task_completion internal event, as the announce flow
  // builds it for completionTarget: "parent" (buildAnnounceReplyInstruction returns
  // SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION).
  const internalEvents = taskCompletionEvents({
    childSessionKey: "agent:main:subagent:child-173650",
    childSessionId: "child-session-173650",
    replyInstruction: SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION,
  });

  const captured = {
    replyInstruction: undefined as string | undefined,
    disableMessageTool: undefined as boolean | undefined,
    toolsAllow: undefined as string[] | undefined,
  };

  // Script the embedded attempt so the real post-run (owner of pendingFinalDelivery)
  // executes. The turn is transcript-only: it produces a visible final payload but
  // never sends through the message tool (no didSendViaMessagingTool evidence).
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    captured.replyInstruction = (
      params.opts.internalEvents?.find((event) => event.type === "task_completion") as
        | { replyInstruction?: string }
        | undefined
    )?.replyInstruction;
    captured.disableMessageTool = params.opts.disableMessageTool;
    captured.toolsAllow = params.opts.toolsAllow;
    return makeCompactionResult({
      sessionId: params.sessionId,
      text: "private parent review",
      runner: "embedded",
    });
  });

  // Drive the real requester completion path. A completionTarget: "parent" private
  // completion runs with deliver: false and sourceReplyDeliveryMode: "automatic"
  // (asserted by the existing private-completion cases, subagent-announce-delivery.test.ts).
  const commandDeliveryResult = await agentCommandFromGatewayIngress(
    {
      sessionKey,
      sessionId,
      runId: "announce:173650",
      message: RUNTIME_EVENT_USER_PROMPT,
      allowModelOverride: false,
      deliver: false,
      sourceReplyDeliveryMode: "automatic",
      privateCompletion: true,
      channel: "telegram",
      to: "direct:173650",
      toolsAllow: ["read", "exec", "sessions_spawn", "message"],
      internalEvents,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child-173650",
        sourceChannel: "internal",
        sourceTool: "subagent_announce",
      },
    },
    ...GATEWAY_INGRESS_ARGS,
  );

  // (a) the admitted turn's task_completion event carries the private instruction.
  expect(captured.replyInstruction).toBe(SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION);
  // (b) the message tool is available in the announce turn's toolset.
  expect(captured.disableMessageTool).not.toBe(true);
  expect(captured.toolsAllow ?? []).toContain("message");
  // (c) after: the outstanding obligation is retained — the transcript-only turn
  // (deliver: false) neither creates a new marker nor clears the pre-existing one.
  const after = compactionTestRuntime.loadSessionEntry(target);
  expect(after?.pendingFinalDelivery).toMatchObject({
    intentId: "owed-intent-1",
    deliveries: [{ id: "owed-delivery-1", state: "prepared" }],
  });
  // (d) the announce result records no requester-visible final (transcript-only).
  // The announce flow computes a private completion's delivery result via
  // resolvePrivateCompletionDeliveryResult from the gateway agent response.
  const { resolvePrivateCompletionDeliveryResult } =
    await import("./subagents/announce/subagent-announce-completion-delivery.js");
  const announceResult = resolvePrivateCompletionDeliveryResult(
    {
      status: "ok",
      inputProcessingCompleted: true,
      result: commandDeliveryResult,
    },
    owedContext,
  );
  expect(announceResult.requesterVisibleFinalDelivered).toBeUndefined();
});
