import path from "node:path";
import type { Mock } from "vitest";
import { expect, it, vi } from "vitest";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { waitForFast, type SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import { markOrphanedMainSessionForRecovery } from "./main-session-restart-recovery-marking.js";

type RecoveryCauseFixture = {
  prepareTranscriptRoot: () => void;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  makeMainSessionFixture: (
    overrides?: SessionEntryFixture & { agentId?: string; sessionKey?: string },
  ) => Promise<{ sessionsDir: string; storePath: string; sessionKey: string }>;
  writeMainSession: (
    params: SessionEntryFixture & { sessionsDir: string; sessionKey?: string },
  ) => Promise<void>;
  writeStore: (sessionsDir: string, store: Record<string, SessionEntryFixture>) => Promise<void>;
  writeCompletedToolTranscript: (sessionsDir: string, human?: boolean) => Promise<void>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  gatewayParams: () => Record<string, unknown>;
  sendRecoveryNotice: Mock<GatewayRecoveryRuntime["sendRecoveryNotice"]>;
  dispatchSettlement: { resolve: () => void };
  mockRecoveryRuntime: GatewayRecoveryRuntime;
};

export function registerMainSessionRecoveryCauseCases(
  getFixture: () => RecoveryCauseFixture,
): void {
  it("uses neutral wording for a pre-upgrade reservation without a persisted cause", async () => {
    const {
      prepareTranscriptRoot,
      makeMainSessionFixture,
      writeCompletedToolTranscript,
      expectRecovery,
      gatewayParams,
    } = getFixture();
    prepareTranscriptRoot();
    // Pre-upgrade state predates cause persistence: the cycle exists but has no cause,
    // so the resume notice must stay neutral and never claim a gateway restart.
    const { sessionsDir } = await makeMainSessionFixture({
      mainRestartRecovery: { cycleId: "pre-upgrade-cycle", revision: 1, chargedAttempts: 0 },
    });
    await writeCompletedToolTranscript(sessionsDir);
    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const message = String(gatewayParams().message);
    expect(message).toContain("The interruption did not cancel the user's task");
    expect(message).not.toContain("interrupted by a gateway restart");
    expect(message).not.toContain("The restart did not cancel the user's task");
  });

  it.each([
    { noticeFails: false, cause: "gateway_restart" },
    { noticeFails: true, cause: "gateway_restart" },
    { noticeFails: false, cause: "unknown" },
    { noticeFails: false, cause: undefined },
  ] as const)(
    "announces an active recovered Telegram topic (notice fails=$noticeFails, cause=$cause)",
    async ({ noticeFails, cause }) => {
      const {
        makeSessionsDir,
        writeMainSession,
        writeCompletedToolTranscript,
        expectRecovery,
        sendRecoveryNotice,
        gatewayParams,
        writeStore,
        dispatchSettlement,
      } = getFixture();
      const sessionsDir = await makeSessionsDir();
      const sessionKey = "agent:main:telegram:group:-100123:topic:99";
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeMainSession({
        sessionsDir,
        sessionKey,
        mainRestartRecovery: { cycleId: "notice-cycle", revision: 1, chargedAttempts: 0, cause },
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123",
          accountId: "work",
          threadId: 99,
        },
      });
      await writeCompletedToolTranscript(sessionsDir);
      if (noticeFails) {
        sendRecoveryNotice.mockRejectedValueOnce(new Error("temporary transport failure"));
      }
      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(sendRecoveryNotice).toHaveBeenCalledOnce();
      const notice = sendRecoveryNotice.mock.calls[0]?.[0];
      expect(notice).toMatchObject({
        channel: "telegram",
        to: "telegram:-100123",
        accountId: "work",
        threadId: 99,
        text: expect.stringContaining("I'm continuing your interrupted request now"),
        idempotencyKey: `main-session-restart-recovery:${String(gatewayParams().idempotencyKey)}:resumed-notice`,
      });
      expect(notice?.text?.includes("the gateway has just restarted")).toBe(
        cause === "gateway_restart",
      );
      expect(String(gatewayParams().message).includes("interrupted by a gateway restart")).toBe(
        cause === "gateway_restart",
      );
      expect(notice?.isCurrent?.({})).toBe(true);
      const current = loadSessionEntry({ sessionKey, storePath });
      if (!current) {
        throw new Error("expected recovered session");
      }
      await writeStore(sessionsDir, {
        [sessionKey]: { ...current, abortedLastRun: true },
      });
      expect(notice?.isCurrent?.({})).toBe(false);
      await writeStore(sessionsDir, {
        [sessionKey]: { ...current, sessionId: "replacement-session" },
      });
      expect(notice?.isCurrent?.({})).toBe(false);
      await writeStore(sessionsDir, { [sessionKey]: current });
      expect(notice?.isCurrent?.({})).toBe(true);
      dispatchSettlement.resolve();
      await waitForFast(() => expect(notice?.isCurrent?.({})).toBe(false));
    },
  );

  it.each(["unknown", undefined] as const)(
    "keeps live orphan reconciliation cause-neutral (previous cause=%s)",
    async (cause) => {
      const {
        makeMainSessionFixture,
        writeCompletedToolTranscript,
        expectRecovery,
        gatewayParams,
        sendRecoveryNotice,
      } = getFixture();
      const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture({
        sessionKey: "agent:main:telegram:group:-100123:topic:99",
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "live-reconciliation-cycle",
          revision: 1,
          chargedAttempts: 0,
          cause,
        },
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123",
          accountId: "work",
          threadId: 99,
        },
      });
      await writeCompletedToolTranscript(sessionsDir);
      await expect(
        markOrphanedMainSessionForRecovery({
          target: { sessionKey, storePath },
          expectedSessionId: "main-session",
        }),
      ).resolves.toEqual({ marked: 1, skipped: 0 });
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: { cause: "unknown" },
      });
      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
      expect(String(gatewayParams().message)).not.toContain("interrupted by a gateway restart");
      expect(sendRecoveryNotice).toHaveBeenCalledOnce();
      expect(sendRecoveryNotice.mock.calls[0]?.[0].text).toContain(
        "I'm continuing your interrupted request now",
      );
      expect(sendRecoveryNotice.mock.calls[0]?.[0].text).not.toContain(
        "the gateway has just restarted",
      );
    },
  );

  it.each(["unknown", undefined] as const)(
    "settles interrupted work after foreground-owner release before a second reply (cause=%s)",
    async (cause) => {
      const {
        makeMainSessionFixture,
        writeCompletedToolTranscript,
        mockRecoveryRuntime,
        gatewayParams,
        sendRecoveryNotice,
      } = getFixture();
      const { sessionsDir, storePath, sessionKey } = await makeMainSessionFixture(
        cause
          ? {
              mainRestartRecovery: {
                cycleId: "unknown-cause-cycle",
                revision: 1,
                chargedAttempts: 0,
                cause,
              },
            }
          : {},
      );
      await writeCompletedToolTranscript(sessionsDir);
      // Keep only the asynchronous scheduler deferred. Claim, release, retry,
      // terminal settlement, and both reply admissions use their real owners.
      const schedule = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const controller = new AbortController();
      let foreground: Awaited<ReturnType<typeof admitReplyTurn>> | undefined;
      let successor: Awaited<ReturnType<typeof admitReplyTurn>> | undefined;
      const request = {
        kind: "visible" as const,
        resetTriggered: false,
        sessionKey,
        sessionId: "main-session",
        expectedSessionId: "main-session",
        storePath,
        upstreamAbortSignal: controller.signal,
      };
      try {
        foreground = await admitReplyTurn({
          ...request,
          resolveGatewayContext: () => undefined,
        });
        expect(foreground.status).toBe("owned");
        if (foreground.status !== "owned") {
          throw new Error("expected the first reply to own the foreground claim");
        }
        expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toMatchObject({
          foregroundClaims: { tokens: [expect.any(String)] },
        });
        foreground.operation.complete();
        await waitForFast(() =>
          expect(schedule).toHaveBeenCalledWith(
            expect.objectContaining({ sessionKey, sessionId: "main-session", storePath }),
          ),
        );
        const released = loadSessionEntry({ sessionKey, storePath });
        expect(released).toMatchObject({ status: "running", abortedLastRun: true });
        expect(released?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
        expect(released?.mainRestartRecovery?.cause).not.toBe("gateway_restart");
        expect(callGateway).not.toHaveBeenCalled();

        vi.mocked(callGateway).mockImplementation(async ({ params }) => ({
          runId: String((params as { idempotencyKey?: unknown }).idempotencyKey),
          status: "ok",
          endedAt: Date.now(),
        }));
        const context = {
          getRuntimeConfig: () => ({}),
          recoveryRuntime: mockRecoveryRuntime,
        } as GatewayRequestContext;
        successor = await admitReplyTurn({ ...request, resolveGatewayContext: () => context });
        expect(successor.status).toBe("owned");
        expect(callGateway).toHaveBeenCalledOnce();
        expect(String(gatewayParams().message)).not.toContain("interrupted by a gateway restart");
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
          sessionId: "main-session",
          status: "done",
          abortedLastRun: false,
        });
        expect(loadSessionEntry({ sessionKey, storePath })?.mainRestartRecovery).toBeUndefined();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        const release = getSessionWorkAdmissionRelease({
          scope: storePath,
          identities: [sessionKey, "main-session"],
        });
        if (foreground?.status === "owned") {
          foreground.operation.complete();
        }
        if (successor?.status === "owned") {
          successor.operation.complete();
        }
        await release;
        schedule.mockRestore();
      }
      expect(callGateway).toHaveBeenCalledOnce();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );
}
