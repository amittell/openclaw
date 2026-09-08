import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../../auto-reply/reply/queue/enqueue.js";
import { clearFollowupQueue } from "../../../auto-reply/reply/queue/state.js";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntryReadOnly,
  readSessionTaskOwnership,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { createWorkerSessionPlacementStore } from "../../../gateway/worker-environments/placement-store.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../../infra/agent-run-registry.js";
import * as systemEvents from "../../../infra/system-events.js";
import {
  beginSessionWorkAdmission,
  isSessionLifecycleMutationActive,
} from "../../../sessions/session-lifecycle-admission.js";
import { recordSubagentTerminalState } from "../../../sessions/session-state-events.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  getTaskById,
  maybeDeliverTaskTerminalUpdate,
  publishTaskRecordAfterAtomicStore,
  reloadTaskRuntimeStateFromStore,
  updateTaskNotifyPolicyById,
} from "../../../tasks/runtime-internal.js";
import {
  configureTaskRegistryMaintenance,
  getInspectableActiveTaskRestartBlockers,
  resetTaskRegistryMaintenanceRuntimeForTests,
  runTaskRegistryMaintenance,
  stopTaskRegistryMaintenance,
} from "../../../tasks/task-registry.maintenance.js";
import {
  listTaskRecordsInDatabase,
  upsertTaskRegistryRecordToSqlite,
} from "../../../tasks/task-registry.store.sqlite.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  resetTaskRegistryForTests,
} from "../../../tasks/task-registry.test-support.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { addSession, deleteSession } from "../../bash-process-registry.js";
import { createProcessSessionFixture } from "../../bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import { setActiveEmbeddedRun, clearActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { saveSubagentRegistryToSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSubagentTaskReconciler } from "./subagent-task-liveness.js";

const childKey = "agent:main:subagent:orphan-fixture";

async function fixture(): Promise<TaskRecord> {
  const old = Date.now() - 60 * 60_000;
  await upsertSessionEntryCore(
    { sessionKey: childKey },
    { sessionId: "orphan-window", updatedAt: old },
  );
  const task: TaskRecord = {
    taskId: "orphan-task",
    runtime: "subagent",
    sourceId: "orphan-run",
    runId: "orphan-run",
    childSessionKey: childKey,
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    agentId: "main",
    scopeKind: "session",
    task: "retained historical task",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: old,
    startedAt: old,
    lastEventAt: old,
  };
  upsertTaskRegistryRecordToSqlite(task);
  publishTaskRecordAfterAtomicStore(task);
  return task;
}

afterEach(() => {
  systemEvents.resetSystemEventsForTest();
  subagentRuns.clear();
  resetAgentRunRegistryForTest();
  resetProcessRegistryForTests();
  stopTaskRegistryMaintenance();
  resetTaskRegistryMaintenanceRuntimeForTests();
  vi.restoreAllMocks();
});

describe("native current orphan owner", () => {
  it("publishes committed state before queued canonical mutation and successor admission", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const database = openOpenClawStateDatabase();
      const session = readSessionTaskOwnership({ sessionKey: childKey });
      const exec = database.db.exec.bind(database.db);
      const successor = createDeferredCore();
      let queued = false;
      let observedStatus: string | undefined;
      let mutationWasActive = false;
      vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        exec(sql);
        if (
          sql === "COMMIT" &&
          !queued &&
          listTaskRecordsInDatabase(database)[0]?.status === "lost"
        ) {
          queued = true;
          queueMicrotask(() => {
            observedStatus = getTaskById(task.taskId)?.status;
            mutationWasActive = isSessionLifecycleMutationActive(session.storePath, [childKey]);
            updateTaskNotifyPolicyById({ taskId: task.taskId, notifyPolicy: "done_only" });
            void beginSessionWorkAdmission({
              scope: session.storePath,
              identities: [childKey, "orphan-window"],
              assertAllowed: () => {},
            }).then((admission) => {
              admission.release();
              successor.resolve();
            }, successor.reject);
          });
        }
      });
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toMatchObject({ status: "lost" });
      expect(queued).toBe(true);
      await successor.promise;
      expect(mutationWasActive).toBe(true);
      expect(observedStatus).toBe("lost");
      const durable = listTaskRecordsInDatabase(database)[0];
      expect(durable).toMatchObject({ status: "lost", notifyPolicy: "done_only" });
      expect(getTaskById(task.taskId)).toEqual(durable);
      expect(isSessionLifecycleMutationActive(session.storePath, [childKey])).toBe(false);
    });
  });

  it.each([false, true])(
    "retains native ownership before installation, authoritative=%s",
    async (authoritative) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = await fixture();
        const missing = { ...task, childSessionKey: "agent:main:subagent:missing" };
        upsertTaskRegistryRecordToSqlite(missing);
        publishTaskRecordAfterAtomicStore(missing);
        configureTaskRegistryMaintenance({ runtimeAuthoritative: authoritative });
        expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
        expect(getTaskById(task.taskId)?.status).toBe("running");
        expect(getInspectableActiveTaskRestartBlockers().map((entry) => entry.taskId)).toContain(
          task.taskId,
        );
      });
    },
  );

  it.each([false, true])(
    "retains a cross-agent old descendant introduced during recovery=%s",
    async (duringRecovery) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = await fixture();
        const descendant = "agent:other:subagent:old-descendant";
        const addDescendant = async () => {
          await upsertSessionEntryCore(
            { sessionKey: descendant, agentId: "other" },
            { sessionId: "cross-old", updatedAt: 1, spawnedBy: childKey },
          );
          await upsertSessionEntryCore(
            { sessionKey: descendant, agentId: "other" },
            { sessionId: "cross-new", updatedAt: 2, spawnedBy: "agent:other:main" },
          );
          registerAgentRunContext("cross-agent-owner", {
            sessionId: "cross-old",
            projectSessionActive: false,
          });
        };
        if (!duringRecovery) {
          await addDescendant();
        }
        const original = readSessionTaskOwnership({ sessionKey: childKey }).signature;
        expect(
          await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
            task,
            Date.now(),
            async () => {
              if (duringRecovery) {
                await addDescendant();
              }
              return false;
            },
          ),
        ).toBeNull();
        expect(getTaskById(task.taskId)?.status).toBe("running");
        expect(readSessionTaskOwnership({ sessionKey: childKey }).signature).toBe(original);
        expect(
          loadSessionEntryReadOnly({ sessionKey: descendant, agentId: "other" })?.sessionId,
        ).toBe("cross-new");
      });
    },
  );

  it("retains raw background ownership after its visible record and task projection disappear", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const processSession = createProcessSessionFixture({
        id: "hidden-process",
        backgrounded: true,
      });
      processSession.scopeKey = "orphan-window";
      addSession(processSession);
      deleteSession(processSession.id);
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });
  it("retains a worker dispatch admitted on a retained old window during recovery", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      await upsertSessionEntryCore(
        { sessionKey: childKey },
        { sessionId: "new-window", updatedAt: Date.now() },
      );
      const owner = createSubagentTaskReconciler({ isRegistryRestored: () => true });
      const result = await owner.reconcile(task, Date.now(), async () => {
        createWorkerSessionPlacementStore().startDispatch({
          sessionId: "orphan-window",
          sessionKey: childKey,
          agentId: "main",
          executionMode: "worker-turn",
        });
        return false;
      });
      expect(result).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });

  it("retains a related CLI task owned by the descendant ledger", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      upsertTaskRegistryRecordToSqlite({
        ...task,
        taskId: "cli-descendant",
        runtime: "cli",
        taskKind: "exec",
        sourceId: "process-descendant",
        runId: "run-descendant",
        requesterSessionKey: childKey,
        parentTaskId: task.taskId,
      });
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });
  it("retains an aborted embedded handle through terminal cleanup without calling abort", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const abort = vi.fn();
      const handle = {
        runId: "terminal-cleanup",
        queueMessage: async () => {},
        isStreaming: () => false,
        isAborted: () => true,
        isCompacting: () => false,
        abort,
      };
      setActiveEmbeddedRun("orphan-window", handle, childKey);
      try {
        expect(
          await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
            task,
            Date.now(),
            async () => false,
          ),
        ).toBeNull();
        expect(abort).not.toHaveBeenCalled();
      } finally {
        clearActiveEmbeddedRun("orphan-window", handle, childKey);
      }
    });
  });

  it("retains the reply delivery barrier after the active reply slot has cleared", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const barrier = createDeferredCore();
      const operation = createReplyOperation({
        sessionKey: childKey,
        sessionId: "orphan-window",
        resetTriggered: false,
      });
      operation.completeWithAfterClearBarrier(barrier.promise);
      try {
        expect(
          await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
            task,
            Date.now(),
            async () => false,
          ),
        ).toBeNull();
      } finally {
        barrier.resolve();
        await operation.ownerSettlement;
      }
    });
  });

  it("retains queued follow-up work before a native execution owner exists", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      enqueueFollowupRun(childKey, createQueueTestRun({ prompt: "queued follow-up" }), {
        mode: "followup",
        debounceMs: 0,
        cap: 20,
        dropPolicy: "summarize",
      });
      try {
        expect(
          await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
            task,
            Date.now(),
            async () => false,
          ),
        ).toBeNull();
      } finally {
        clearFollowupQueue(childKey);
      }
    });
  });

  it("retains an admitted owner without interrupting or draining it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const session = readSessionTaskOwnership({ sessionKey: childKey });
      const interrupt = vi.fn();
      const admission = await beginSessionWorkAdmission({
        scope: session.storePath,
        identities: [childKey, "orphan-window"],
        assertAllowed: () => {},
        onInterrupt: interrupt,
      });
      try {
        expect(
          await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
            task,
            Date.now(),
            async () => false,
          ),
        ).toBeNull();
        expect(interrupt).not.toHaveBeenCalled();
      } finally {
        admission.release();
      }
    });
  });

  it("leaves the durable row and published mirror active when the actual SQLite update fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const database = openOpenClawStateDatabase();
      // sqlite-allow-raw -- Test-only trigger injects a genuine failure at the task write boundary.
      database.db.exec(
        "CREATE TRIGGER reject_orphan_update BEFORE UPDATE ON task_runs BEGIN SELECT RAISE(ABORT, 'fixture write refusal'); END;",
      );
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
      expect(listTaskRecordsInDatabase(database)[0]?.status).toBe("running");
    });
  });
  it.each([false, true])(
    "commits lost with historical outcome unknown using fresh-reader=%s",
    async (fresh) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = await fixture();
        const before = readSessionTaskOwnership({ sessionKey: childKey });
        if (fresh) {
          closeOpenClawAgentDatabasesForTest();
        }
        const owner = createSubagentTaskReconciler({ isRegistryRestored: () => true });
        const hook = vi.fn(async () => false);
        const next = await owner.reconcile(task, Date.now(), hook);
        expect(next).toMatchObject({
          status: "lost",
          error: expect.stringContaining("historical outcome unknown"),
        });
        expect(hook).toHaveBeenCalledOnce();
        expect(getTaskById(task.taskId)?.status).toBe("lost");
        expect(listTaskRecordsInDatabase(openOpenClawStateDatabase())[0]?.status).toBe("lost");
        expect(readSessionTaskOwnership({ sessionKey: childKey }).signature).toBe(before.signature);
      });
    },
  );

  it("maintenance commits the actual orphan before removing its restart blocker", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      configureTaskRegistryMaintenance({
        runtimeAuthoritative: true,
        subagentReconciler: createSubagentTaskReconciler({ isRegistryRestored: () => true }),
      });
      expect(getInspectableActiveTaskRestartBlockers().map((entry) => entry.taskId)).toContain(
        task.taskId,
      );
      expect((await runTaskRegistryMaintenance()).reconciled).toBe(1);
      expect(getTaskById(task.taskId)?.status).toBe("lost");
      expect(getInspectableActiveTaskRestartBlockers().map((entry) => entry.taskId)).not.toContain(
        task.taskId,
      );
      expect(loadSessionEntryReadOnly({ sessionKey: childKey })?.sessionId).toBe("orphan-window");
    });
  });

  it.each([
    ["done_only", "pending"],
    ["state_changes", "pending"],
    ["state_changes", "delivered"],
    ["silent", "not_applicable"],
  ] as const)(
    "queues the requester outcome for %s after %s",
    async (notifyPolicy, deliveryStatus) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = {
          ...(await fixture()),
          notifyPolicy,
          deliveryStatus,
        };
        upsertTaskRegistryRecordToSqlite(task);
        publishTaskRecordAfterAtomicStore(task);
        if (notifyPolicy === "state_changes" && deliveryStatus === "pending") {
          // The actual progress owner refreshes liveness. Emit it in the old
          // window so the later census still observes the real grace period.
          const progressClock = vi.spyOn(Date, "now").mockReturnValue(task.lastEventAt! + 1);
          try {
            await maybeDeliverTaskStateChangeUpdate(task.taskId, {
              at: task.lastEventAt! + 1,
              kind: "progress",
              summary: "Checking current execution owner",
            });
          } finally {
            progressClock.mockRestore();
          }
          expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([
            expect.stringContaining("Checking current execution owner"),
          ]);
        }
        const priorEvents = systemEvents.peekSystemEvents(task.ownerKey);
        configureTaskRegistryMaintenance({
          runtimeAuthoritative: true,
          subagentReconciler: createSubagentTaskReconciler({ isRegistryRestored: () => true }),
        });
        expect((await runTaskRegistryMaintenance()).reconciled).toBe(1);
        const lost = getTaskById(task.taskId);
        const silent = notifyPolicy === "silent";
        expect(lost).toMatchObject({
          status: "lost",
          deliveryStatus: silent ? "not_applicable" : "session_queued",
        });
        expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([
          ...priorEvents,
          ...(silent
            ? []
            : [
                expect.stringContaining(
                  "No current subagent execution owner; historical outcome unknown",
                ),
              ]),
        ]);
        expect(await maybeDeliverTaskTerminalUpdate(task.taskId)).toEqual(lost);
        expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
        expect(systemEvents.peekSystemEvents(task.ownerKey)).toHaveLength(
          priorEvents.length + (silent ? 0 : 1),
        );
        expect(listTaskRecordsInDatabase(openOpenClawStateDatabase())[0]).toEqual(lost);
      });
    },
  );

  it("resumes a committed pending outcome after restart without offline delivery", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = { ...(await fixture()), notifyPolicy: "done_only" as const };
      upsertTaskRegistryRecordToSqlite(task);
      publishTaskRecordAfterAtomicStore(task);
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toMatchObject({ status: "lost", deliveryStatus: "pending" });
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([]);
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryMaintenance({ runtimeAuthoritative: false });
      expect((await runTaskRegistryMaintenance()).pruned).toBe(0);
      expect(getTaskById(task.taskId)).toMatchObject({ status: "lost", deliveryStatus: "pending" });
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([]);
      configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
      await runTaskRegistryMaintenance();
      expect(getTaskById(task.taskId)?.deliveryStatus).toBe("session_queued");
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([
        expect.stringContaining("historical outcome unknown"),
      ]);
      await runTaskRegistryMaintenance();
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toHaveLength(1);
    });
  });

  it("retries a failed orphan enqueue after reload before retiring its record", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = { ...(await fixture()), notifyPolicy: "done_only" as const };
      upsertTaskRegistryRecordToSqlite(task);
      publishTaskRecordAfterAtomicStore(task);
      configureTaskRegistryMaintenance({
        runtimeAuthoritative: true,
        subagentReconciler: createSubagentTaskReconciler({ isRegistryRestored: () => true }),
      });
      const failure = vi.spyOn(systemEvents, "enqueueSystemEvent").mockImplementation(() => {
        throw new Error("owned queue admission failure");
      });
      await runTaskRegistryMaintenance();
      const lost = getTaskById(task.taskId)!;
      expect(lost.deliveryStatus).toBe("failed");
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([]);
      reloadTaskRuntimeStateFromStore();
      vi.spyOn(Date, "now").mockReturnValue(lost.endedAt! + 2 * 24 * 60 * 60_000);
      expect((await runTaskRegistryMaintenance()).pruned).toBe(0);
      expect(getTaskById(task.taskId)?.deliveryStatus).toBe("failed");
      failure.mockRestore();
      expect((await runTaskRegistryMaintenance()).pruned).toBe(1);
      expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([
        expect.stringContaining("historical outcome unknown"),
      ]);
      expect(getTaskById(task.taskId)).toBeUndefined();
    });
  });

  it.each(["silent", "progress", "cancelled", "pending", "covered", "other-owner"] as const)(
    "delivers orphan outcomes once without confusion from a %s peer",
    async (peerKind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = { ...(await fixture()), notifyPolicy: "done_only" as const };
        upsertTaskRegistryRecordToSqlite(task);
        publishTaskRecordAfterAtomicStore(task);
        const lost = await createSubagentTaskReconciler({
          isRegistryRestored: () => true,
        }).reconcile(task, Date.now(), async () => false);
        expect(lost).not.toBeNull();
        const peer: TaskRecord = {
          ...lost!,
          taskId: "earlier-peer",
          createdAt: task.createdAt - 1,
          ...(peerKind === "silent" ? { notifyPolicy: "silent" } : {}),
          ...(peerKind === "cancelled"
            ? { status: "cancelled", error: "Cancelled by operator." }
            : {}),
          ...(peerKind === "progress"
            ? {
                status: "running",
                error: undefined,
                endedAt: undefined,
                deliveryStatus: "delivered",
              }
            : {}),
          ...(peerKind === "other-owner" ? { ownerKey: "agent:main:other" } : {}),
        };
        upsertTaskRegistryRecordToSqlite(peer);
        publishTaskRecordAfterAtomicStore(peer);
        configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
        if (peerKind === "covered") {
          await maybeDeliverTaskTerminalUpdate(peer.taskId);
        }
        await runTaskRegistryMaintenance();
        await Promise.all([
          maybeDeliverTaskTerminalUpdate(task.taskId),
          maybeDeliverTaskTerminalUpdate(peer.taskId),
        ]);
        await runTaskRegistryMaintenance();
        expect(systemEvents.peekSystemEvents(task.ownerKey)).toEqual([
          expect.stringContaining("historical outcome unknown"),
        ]);
        if (peerKind === "other-owner") {
          expect(systemEvents.peekSystemEvents(peer.ownerKey)).toHaveLength(1);
        }
        expect(getTaskById(task.taskId)?.deliveryStatus).toBe(
          peerKind === "pending" || peerKind === "covered" ? "not_applicable" : "session_queued",
        );
      });
    },
  );

  it("retains incomplete restoration without invoking recovery or publishing a mirror", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const hook = vi.fn(async () => false);
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => false }).reconcile(
          task,
          Date.now(),
          hook,
        ),
      ).toBeNull();
      expect(hook).not.toHaveBeenCalled();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });

  it.each(["memory", "persisted"])("retains terminal native cleanup from %s", async (source) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const run: SubagentRunRecord = {
        runId: task.runId!,
        childSessionKey: childKey,
        requesterSessionKey: task.requesterSessionKey,
        requesterDisplayKey: "main",
        task: "cleanup",
        cleanup: "keep",
        createdAt: task.createdAt,
        execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
        completion: { required: true },
        delivery: { status: "pending" },
      };
      if (source === "memory") {
        subagentRuns.set(run.runId, run);
      } else {
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
      }
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });

  it.each(["new-owner", "new-window", "generation", "task-progress"])(
    "retains %s introduced while the recovery hook yields",
    async (race) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const task = await fixture();
        const owner = createSubagentTaskReconciler({ isRegistryRestored: () => true });
        const next = await owner.reconcile(task, Date.now(), async () => {
          if (race === "new-owner") {
            registerAgentRunContext("new-run", {
              sessionKey: childKey,
              projectSessionActive: false,
            });
          }
          if (race === "new-window") {
            await upsertSessionEntryCore(
              { sessionKey: childKey },
              { sessionId: "new-window", updatedAt: Date.now() },
            );
          }
          if (race === "generation") {
            rotateAgentRunRegistryLifecycleGeneration();
          }
          if (race === "task-progress") {
            const progressed = { ...task, lastEventAt: Date.now() };
            upsertTaskRegistryRecordToSqlite(progressed);
            publishTaskRecordAfterAtomicStore(progressed);
          }
          return false;
        });
        expect(next).toBeNull();
        expect(getTaskById(task.taskId)?.status).toBe("running");
        expect(listTaskRecordsInDatabase(openOpenClawStateDatabase())[0]?.status).toBe("running");
      });
    },
  );

  it("preserves a real terminal receipt for its outcome owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      recordSubagentTerminalState({
        childSessionKey: childKey,
        runId: task.runId!,
        requesterSessionKey: task.requesterSessionKey,
        outcomeStatus: "ok",
      });
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });

  it("retains a hidden owner on an empty old descendant window after reparenting", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const task = await fixture();
      const descendant = "agent:main:subagent:old-descendant";
      await upsertSessionEntryCore(
        { sessionKey: descendant },
        { sessionId: "descendant-old", updatedAt: 1, spawnedBy: childKey },
      );
      await upsertSessionEntryCore(
        { sessionKey: descendant },
        { sessionId: "descendant-new", updatedAt: 2, spawnedBy: "agent:main:other" },
      );
      registerAgentRunContext("hidden-descendant-run", {
        sessionId: "descendant-old",
        projectSessionActive: false,
      });
      expect(
        await createSubagentTaskReconciler({ isRegistryRestored: () => true }).reconcile(
          task,
          Date.now(),
          async () => false,
        ),
      ).toBeNull();
      expect(getTaskById(task.taskId)?.status).toBe("running");
    });
  });
});
