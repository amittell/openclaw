import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import { restoreSubagentRunsFromDisk } from "./subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRestorer() {
  const runs = new Map<string, SubagentRunRecord>();
  const restore = vi.fn(restoreSubagentRunsFromDisk);
  const ensureListener = vi.fn();
  const restorer = createSubagentRegistryRestorer({
    runs,
    resumedRuns: new Set(),
    deps: () => ({ ...subagentRegistryDeps, restoreSubagentRunsFromDisk: restore }),
    getGatewayContextResolver: () => undefined,
    persist: () => undefined,
    persistOrThrow: () => undefined,
    settleRequesterTurn: () => false,
    ensureListener,
    startSweeper: () => undefined,
    resumeRun: () => undefined,
    listSwarmRunsForGroup: () => [],
    startQueuedSubagentRun: () => false,
    terminateAcceptedRestoredCollectorRun: async () => undefined,
    cleanupCollectorLaunchResources: async () => true,
    settleFailedQueuedSubagentLaunch: () => false,
    completeCollectorLaunchCleanup: () => undefined,
    warn: () => undefined,
  });
  return { runs, restore, ensureListener, restorer };
}

function persistRecoveryOwnedRun(): string {
  const record: SubagentRunRecord = {
    runId: "restoration-readiness-run",
    childSessionKey: "agent:main:subagent:restoration-readiness",
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    task: "restore a retained execution owner",
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: "running" },
    completion: { required: false },
    delivery: { status: "not_required" },
    killIntent: { requestedAt: Date.now(), reason: "killed", sessionId: "recovery-window" },
  };
  saveSubagentRegistryToSqlite(new Map([[record.runId, record]]));
  return record.runId;
}

afterEach(() => {
  resetAgentEventsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subagent restoration readiness", () => {
  it.each([false, true])(
    "requires complete activation when requested before restore=%s",
    async (early) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { restorer } = createRestorer();
        try {
          expect(restorer.isRestored()).toBe(false);
          if (early) {
            restorer.activate();
          }
          expect(restorer.isRestored()).toBe(false);
          restorer.restoreOnce();
          expect(restorer.isRestored()).toBe(early);
          restorer.activate();
          expect(restorer.isRestored()).toBe(true);
          restorer.reset();
          expect(restorer.isRestored()).toBe(false);
        } finally {
          restorer.reset();
        }
      });
    },
  );

  it("keeps partial-merge restoration unavailable until retry reconciles the retained row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.useFakeTimers();
      const runId = persistRecoveryOwnedRun();
      const { restorer, restore, runs, ensureListener } = createRestorer();
      restore.mockImplementationOnce((params) => {
        restoreSubagentRunsFromDisk(params);
        throw new Error("read failed after merging one persisted owner");
      });
      ensureListener.mockImplementation(() => {
        expect(restorer.isRestored()).toBe(false);
      });
      try {
        restorer.activate();
        restorer.restoreOnce();
        expect(runs.has(runId)).toBe(true);
        expect(restorer.isRestored()).toBe(false);
        expect(ensureListener).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(restore).toHaveBeenCalledTimes(2);
        expect(restore.mock.results[1]?.value).toBe(0);
        expect(ensureListener).toHaveBeenCalledOnce();
        expect(restorer.isRestored()).toBe(true);
        expect(runs.get(runId)?.killIntent?.sessionId).toBe("recovery-window");
      } finally {
        restorer.reset();
      }
    });
  });

  it("does not advertise readiness after activation fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      persistRecoveryOwnedRun();
      const { restorer, ensureListener } = createRestorer();
      ensureListener.mockImplementationOnce(() => {
        throw new Error("listener registration unavailable");
      });
      try {
        restorer.restoreOnce();
        expect(() => restorer.activate()).toThrow("listener registration unavailable");
        expect(restorer.isRestored()).toBe(false);
        restorer.activate();
        expect(restorer.isRestored()).toBe(true);
      } finally {
        restorer.reset();
      }
    });
  });

  it("requires restoration in the current lifecycle after generation rotation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { restorer } = createRestorer();
      try {
        restorer.restoreOnce();
        restorer.activate();
        expect(restorer.isRestored()).toBe(true);
        rotateAgentEventLifecycleGeneration();
        expect(restorer.isRestored()).toBe(false);
        restorer.restoreOnce();
        restorer.activate();
        expect(restorer.isRestored()).toBe(false);
        restorer.reset();
        restorer.activate();
        restorer.restoreOnce();
        expect(restorer.isRestored()).toBe(true);
      } finally {
        restorer.reset();
      }
    });
  });
});
