import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  isEmbeddedAgentRunActive,
  preemptAndDrainEmbeddedHeartbeatRun,
  resolveActiveEmbeddedRunSessionId,
} from "../../agents/embedded-agent.runtime.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createInboundTurn, createSessionTurn } from "./get-reply-run.test-support.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import { REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, createReplyOperation } from "./reply-run-registry.js";

type ReplyRunParams = Parameters<typeof runPreparedReply>[0];

function telegramDirectTurn(body: string) {
  const route = { OriginatingChannel: "telegram", OriginatingTo: "user:1" };
  return {
    ctx: { ...createInboundTurn(body, "telegram", "direct"), ...route },
    sessionCtx: { ...createSessionTurn(body, "telegram", "direct"), ...route },
  };
}

/** Callers mock the embedded agent runtime; these cases drive its heartbeat drain. */
export function registerHeartbeatPreemptionCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (overrides?: Partial<ReplyRunParams>) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  it("queues interrupt-mode turns behind admitted recovery after heartbeat preemption", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const storePath = "/tmp/recovery-admission-sessions.json";
    const recoveryAdmission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-key", "session-recovery-starting"],
      owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
      assertAllowed: () => {},
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "interrupt" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(
      "session-embedded-heartbeat",
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
      "drained",
    );

    try {
      await expect(
        runPrepared({
          isNewSession: false,
          sessionId: "session-recovery-starting",
          storePath,
        }),
      ).resolves.toEqual({ text: "ok" });

      const call = requireRunReplyAgentCall();
      expect(call.isActive).toBe(true);
      expect(call.shouldSteer).toBe(false);
      expect(call.shouldFollowup).toBe(true);
    } finally {
      recoveryAdmission.release();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockResolvedValue(
        "not-heartbeat",
      );
    }
  });
  it("drains an embedded heartbeat hidden by the visible pre-dispatch operation", async () => {
    const queueSettings = await import("./queue/settings-runtime.js");
    const embeddedAgentRuntime = await import("../../agents/embedded-agent.runtime.js");
    const operation = createReplyOperation({
      sessionId: "session-pre-dispatch-heartbeat",
      sessionKey: "session-key",
      turnKind: "visible",
      resetTriggered: false,
    });
    let embeddedRunActive = true;
    let releaseDrain: (() => void) | undefined;
    const drainBarrier = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    vi.mocked(queueSettings.resolveQueueSettings).mockReturnValueOnce({ mode: "steer" });
    vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
      embeddedRunActive ? "session-pre-dispatch-heartbeat" : undefined,
    );
    vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(
      async () => {
        await drainBarrier;
        embeddedRunActive = false;
        return "drained";
      },
    );
    vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockImplementation(
      () => embeddedRunActive,
    );
    vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).mockImplementation(async () => {
      await drainBarrier;
      embeddedRunActive = false;
      return true;
    });

    try {
      const runPromise = runPrepared({
        isNewSession: false,
        sessionId: "session-pre-dispatch-heartbeat",
        opts: { replyOperation: operation } as never,
        ...telegramDirectTurn("answer this now"),
      });

      await vi.waitFor(
        () => {
          expect(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledWith(
            "session-pre-dispatch-heartbeat",
            REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
          );
        },
        { timeout: 1_000 },
      );
      expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
      expect(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();

      releaseDrain?.();
      await expect(runPromise).resolves.toEqual({ text: "ok" });
    } finally {
      releaseDrain?.();
      operation.complete();
      vi.mocked(embeddedAgentRuntime.resolveActiveEmbeddedRunSessionId)
        .mockReset()
        .mockReturnValue(undefined);
      vi.mocked(embeddedAgentRuntime.preemptAndDrainEmbeddedHeartbeatRun)
        .mockReset()
        .mockResolvedValue("not-heartbeat");
      vi.mocked(embeddedAgentRuntime.isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
      vi.mocked(embeddedAgentRuntime.waitForEmbeddedAgentRunEnd)
        .mockReset()
        .mockResolvedValue(true);
    }

    expect(vi.mocked(runReplyAgent)).toHaveBeenCalledOnce();
  });
  it.for(["visible", "exec completion"] as const)(
    "preempts an embedded heartbeat only for visible turns (%s)",
    async (kind, { signal }) => {
      const completion = kind === "exec completion";
      const mode = completion ? "followup" : "steer";
      vi.mocked(resolveQueueSettings).mockReturnValueOnce({ mode });
      const sessionId = "session-embedded-heartbeat";
      const heartbeat = createReplyOperation({
        sessionId,
        sessionKey: "session-key",
        turnKind: "heartbeat",
        resetTriggered: false,
      });
      const preempted = createDeferred();
      const drained = createDeferred();
      let heartbeatActive = true;
      vi.mocked(resolveActiveEmbeddedRunSessionId).mockImplementation(() =>
        heartbeatActive ? sessionId : undefined,
      );
      vi.mocked(isEmbeddedAgentRunActive).mockImplementation(() => heartbeatActive);
      // The embedded heartbeat queue handle preempts by superseding its reply operation.
      vi.mocked(preemptAndDrainEmbeddedHeartbeatRun).mockImplementation(async () => {
        heartbeat.supersede();
        preempted.resolve();
        await drained.promise;
        heartbeatActive = false;
        return "drained";
      });
      const opts: ReplyRunParams["opts"] = completion
        ? { internalEventExecution: { onStarted: vi.fn(), onTerminal: vi.fn() } }
        : {};
      const body = completion ? "Exec completed (health-check, code 0) :: OK" : "answer this now";
      const running = runPrepared({
        isNewSession: false,
        sessionId,
        opts,
        ...telegramDirectTurn(body),
      });
      try {
        if (completion) {
          await withinTest(
            awaitGateBeforeSettlement(
              running,
              preempted.promise,
              "Exec completion superseded its originating heartbeat",
            ),
            signal,
          );
          expect(preemptAndDrainEmbeddedHeartbeatRun).not.toHaveBeenCalled();
          expect(heartbeat.abortSignal.aborted).toBe(false);
          expect(heartbeat.result).toBeNull();
          expect(requireRunReplyAgentCall()).toMatchObject({
            shouldSteer: false,
            shouldFollowup: true,
            isActive: true,
          });
          return;
        }
        await withinTest(
          awaitGateBeforeSettlement(
            preempted.promise,
            running,
            "Visible turn bypassed the heartbeat",
          ),
          signal,
        );
        expect(runReplyAgent).not.toHaveBeenCalled();
        expect(heartbeat.result).toEqual({ kind: "aborted", code: "aborted_for_supersession" });
        heartbeat.complete();
        drained.resolve();

        await expect(withinTest(running, signal)).resolves.toEqual({ text: "ok" });
        expect(preemptAndDrainEmbeddedHeartbeatRun).toHaveBeenCalledExactlyOnceWith(
          sessionId,
          REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
        );
        expect(runReplyAgent).toHaveBeenCalledOnce();
        expect(requireRunReplyAgentCall()).toMatchObject({
          shouldSteer: false,
          shouldFollowup: false,
          isActive: false,
        });
      } finally {
        drained.resolve();
        heartbeat.complete();
        await running.catch(() => {});
        vi.mocked(resolveActiveEmbeddedRunSessionId).mockReset().mockReturnValue(undefined);
        vi.mocked(isEmbeddedAgentRunActive).mockReset().mockReturnValue(false);
        vi.mocked(preemptAndDrainEmbeddedHeartbeatRun)
          .mockReset()
          .mockResolvedValue("not-heartbeat");
      }
    },
  );
}
