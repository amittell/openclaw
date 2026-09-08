/** Gateway-owned current-orphan reconciliation. Historical outcomes remain unknown. */
import {
  getExistingFollowupQueue,
  hasPendingFollowupQueueWork,
} from "../../../auto-reply/reply/queue/state.js";
import {
  readSessionTaskOwnership,
  type SessionTaskOwnershipObservation,
} from "../../../config/sessions/session-accessor.js";
import { fromRow, query } from "../../../gateway/worker-environments/placement-row-codec.js";
import { hasWorkerWorkspacePendingResult } from "../../../gateway/worker-environments/placement-workspace-result.js";
import {
  getAgentRunLifecycleGeneration,
  hasAgentRunContextForTask,
  readAgentRunIndexVersion,
} from "../../../infra/agent-run-registry.js";
import { executeSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import {
  isSessionLifecycleMutationActive,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../../sessions/session-lifecycle-admission.js";
import { hasTaskTerminalSessionStateEvent } from "../../../sessions/session-state-events.js";
import {
  assertAgentDatabaseLeaseObservationCurrent,
  observeAgentDatabaseLeasesForReconciliation,
  type AgentDatabaseLeaseObservation,
} from "../../../state/openclaw-agent-db-lease.js";
import { ownsOpenClawAgentDatabaseLease } from "../../../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry-mutation.js";
import {
  listTaskRecordsInDatabase,
  markOrphanTaskLostInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { hasProcessSessionForTask } from "../../bash-process-registry.js";
import { hasEmbeddedOrReplyRunForTask } from "../../embedded-agent-runner/active-run-projections.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  isCanonicalSubagentRunRecord,
  loadSubagentRegistryForReconciliationInDatabase,
} from "./subagent-registry.store.sqlite.js";

export type SubagentTaskReconciler = {
  reconcile: (
    task: TaskRecord,
    now: number,
    beforeCommit: () => Promise<boolean>,
  ) => Promise<TaskRecord | null>;
};

type Observation = {
  session: SessionTaskOwnershipObservation;
  leases: AgentDatabaseLeaseObservation;
  generation: string;
  runIndexVersion: number;
};

function assertAbsent(condition: boolean): void {
  if (condition) {
    throw new Error("Subagent task still has an execution owner or unresolved evidence");
  }
}

/** Every present native generation is retained, including terminal cleanup and delivery. */
function assertNativeAbsence(
  database: OpenClawStateDatabase,
  runIds: ReadonlySet<string>,
  sessionKeys: ReadonlySet<string>,
): void {
  const persisted = loadSubagentRegistryForReconciliationInDatabase(database);
  for (const runs of [persisted, subagentRuns]) {
    for (const [runId, run] of runs) {
      assertAbsent(
        !isCanonicalSubagentRunRecord(run) ||
          !runId ||
          run.runId !== runId ||
          !run.childSessionKey ||
          !run.requesterSessionKey,
      );
      assertAbsent(
        runIds.has(runId) ||
          sessionKeys.has(run.childSessionKey) ||
          sessionKeys.has(run.requesterSessionKey) ||
          Boolean(run.controllerSessionKey && sessionKeys.has(run.controllerSessionKey)),
      );
    }
  }
}

function assertWorkerAbsence(
  database: OpenClawStateDatabase,
  identities: {
    runIds: ReadonlySet<string>;
    sessionKeys: ReadonlySet<string>;
    sessionIds: ReadonlySet<string>;
  },
): void {
  const db = database.db;
  for (const row of executeSqliteQuerySync(
    db,
    query(db).selectFrom("worker_session_placements").selectAll(),
  ).rows) {
    const placement = fromRow(row);
    if (
      identities.sessionKeys.has(placement.sessionKey) ||
      identities.sessionIds.has(placement.sessionId) ||
      (placement.turnClaim && identities.runIds.has(placement.turnClaim.runId))
    ) {
      assertAbsent(placement.state !== "local" || placement.turnClaim !== null);
    }
  }
  const operations = executeSqliteQuerySync(
    db,
    query(db)
      .selectFrom("worker_session_tool_operations")
      .select("source_session_id")
      .where("source_session_id", "in", [...identities.sessionIds]),
  ).rows;
  // Retained operations are another owner's history; do not infer their closure here.
  assertAbsent(operations.length > 0);
  for (const sessionId of identities.sessionIds) {
    assertAbsent(hasWorkerWorkspacePendingResult(db, sessionId));
  }
}

function assertCurrentAbsence(
  database: OpenClawStateDatabase,
  task: TaskRecord,
  session: SessionTaskOwnershipObservation,
): void {
  const identities = {
    runIds: new Set([task.runId!, task.sourceId!]),
    sessionKeys: new Set(session.sessionKeys),
    sessionIds: new Set(session.sessionIds),
  };
  assertNativeAbsence(database, identities.runIds, identities.sessionKeys);
  assertAbsent(hasAgentRunContextForTask(identities));
  assertAbsent(hasEmbeddedOrReplyRunForTask(identities));
  assertAbsent(hasProcessSessionForTask(identities));
  assertAbsent(hasPendingFollowupQueueWork([...identities.sessionKeys, ...identities.sessionIds]));
  for (const key of [...identities.sessionKeys, ...identities.sessionIds]) {
    const queue = getExistingFollowupQueue(key);
    assertAbsent(
      Boolean(
        queue &&
        (queue.draining ||
          queue.drainOwner ||
          queue.summarySources.length ||
          queue.summaryElisions.length ||
          queue.evictedSummaryCount),
      ),
    );
  }
  assertAbsent(
    isSessionWorkAdmissionActive(session.storePath, [
      ...identities.sessionKeys,
      ...identities.sessionIds,
    ]),
  );
  for (const other of listTaskRecordsInDatabase(database)) {
    if (other.taskId === task.taskId) {
      continue;
    }
    // A related ledger owner, even terminal, retains its own outcome and descendants.
    assertAbsent(
      other.parentTaskId === task.taskId ||
        identities.sessionKeys.has(other.requesterSessionKey) ||
        identities.sessionKeys.has(other.ownerKey) ||
        Boolean(other.childSessionKey && identities.sessionKeys.has(other.childSessionKey)) ||
        Boolean(other.runId && identities.runIds.has(other.runId)) ||
        Boolean(other.sourceId && identities.runIds.has(other.sourceId)),
    );
  }
  assertWorkerAbsence(database, identities);
  assertAbsent(
    hasTaskTerminalSessionStateEvent(database.db, {
      runIds: [...identities.runIds],
      sessionKeys: session.sessionKeys,
    }),
  );
}

function readSession(task: TaskRecord): SessionTaskOwnershipObservation {
  const child = task.childSessionKey;
  const parsed = child ? parseAgentSessionKey(child) : null;
  if (
    task.runtime !== "subagent" ||
    !child ||
    !parsed ||
    !task.runId?.trim() ||
    !task.sourceId?.trim() ||
    task.runId.trim() !== task.runId ||
    task.sourceId.trim() !== task.sourceId ||
    (task.agentId && task.agentId !== parsed.agentId)
  ) {
    throw new Error("Subagent task lacks exact canonical ownership identity");
  }
  return readSessionTaskOwnership({ sessionKey: child, agentId: parsed.agentId });
}

/** Installed by the actual Gateway activation owner, never by standalone maintenance. */
export function createSubagentTaskReconciler(params: {
  isRegistryRestored: () => boolean;
}): SubagentTaskReconciler {
  const generation = getAgentRunLifecycleGeneration();
  const assertReady = () => {
    assertAbsent(!params.isRegistryRestored() || getAgentRunLifecycleGeneration() !== generation);
  };
  return {
    async reconcile(task, now, beforeCommit) {
      let database: OpenClawStateDatabase;
      let observed: Observation;
      try {
        assertReady();
        database = openOpenClawStateDatabase();
        assertAbsent(
          database.db.isTransaction || database.path !== resolveOpenClawStateSqlitePath(),
        );
        const session = readSession(task);
        assertAbsent(
          isSessionLifecycleMutationActive(session.storePath, [
            ...session.sessionKeys,
            ...session.sessionIds,
          ]),
        );
        assertCurrentAbsence(database, task, session);
        observed = {
          session,
          generation,
          runIndexVersion: readAgentRunIndexVersion(),
          leases: observeAgentDatabaseLeasesForReconciliation({
            database,
            agentId: session.agentId,
            path: session.databasePath,
          }),
        };
      } catch {
        // Missing schema, incomplete restore, unreadable/ambiguous ownership all retain.
        return null;
      }
      if (await beforeCommit()) {
        return null;
      }
      try {
        return await runExclusiveSessionLifecycleMutation({
          scope: observed.session.storePath,
          identities: [...observed.session.sessionKeys, ...observed.session.sessionIds],
          run: async () => {
            assertReady();
            assertAbsent(
              database.db.isTransaction ||
                observed.generation !== getAgentRunLifecycleGeneration() ||
                observed.runIndexVersion !== readAgentRunIndexVersion(),
            );
            const next = runOpenClawStateWriteTransaction(
              () => {
                const fresh = readSession(task);
                assertAbsent(fresh.signature !== observed.session.signature);
                assertAgentDatabaseLeaseObservationCurrent({
                  database,
                  observation: observed.leases,
                  ownsLocalLease: (leaseId) =>
                    Boolean(
                      fresh.localDatabase &&
                      ownsOpenClawAgentDatabaseLease({
                        database: fresh.localDatabase,
                        statePath: database.path,
                        leaseId,
                      }),
                    ),
                });
                assertCurrentAbsence(database, task, fresh);
                assertReady();
                return markOrphanTaskLostInDatabase({ database, expected: task, now });
              },
              { database },
              { busyTimeoutMs: 0, operationLabel: "task.reconcile-current-subagent-orphan" },
            );
            // Publish synchronously after COMMIT, before this lifecycle owner
            // yields to queued task mutations or releases successor admissions.
            // Maintenance delivers this committed unknown outcome after admission closes.
            return next ? publishTaskRecordAfterAtomicStore(next) : null;
          },
        });
      } catch {
        return null;
      }
    },
  };
}
