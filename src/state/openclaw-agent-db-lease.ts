import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import {
  assertAgentDeletionIdentityClaimAllowed,
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { assertSingleAgentDatabaseReconciliationDomain } from "./openclaw-agent-db-registry-listing.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

type AgentDatabaseLeaseDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_database_leases" | "agent_deletion_journal" | "state_leases"
>;

type AgentDatabaseLeaseRow = Selectable<OpenClawStateKyselyDatabase["agent_database_leases"]>;

export type AgentDatabaseLeaseObservation = {
  agentId: string;
  path: string;
  fileIdentity: string;
  rows: readonly AgentDatabaseLeaseRow[];
  targetLeaseIds: ReadonlySet<string>;
  deadLeaseIds: ReadonlySet<string>;
};

function agentDatabaseFileIdentity(pathname: string): string {
  if (realpathSync(pathname) !== pathname) {
    throw new Error("Agent reconciliation requires an unambiguous database path");
  }
  const stat = statSync(pathname, { bigint: true });
  if (!stat.isFile()) {
    throw new Error("Agent reconciliation requires a regular database file");
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function readAgentDatabaseLeaseRows(database: Pick<OpenClawStateDatabase, "db">) {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("agent_database_leases").selectAll().orderBy("lease_id"),
  ).rows;
}

function assertAgentDatabaseReconciliationAuthoritiesAbsent(
  database: Pick<OpenClawStateDatabase, "db">,
): void {
  const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
  const maintenance = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("state_leases")
      .select("owner")
      .where("scope", "=", AGENT_DATABASE_MAINTENANCE_LEASE.scope)
      .where("lease_key", "=", AGENT_DATABASE_MAINTENANCE_LEASE.key),
  );
  const deletion = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("agent_deletion_journal").select("agent_id").limit(1),
  );
  // Deletion can fence another agent through overlapping paths. Any retained deletion
  // conservatively blocks this rare reconciliation; do not reimplement path ownership.
  // An expired maintenance record is not evidence that its physical writer has stopped.
  if (maintenance || deletion) {
    throw new Error("Agent database has an unresolved maintenance or deletion owner");
  }
}

/** Plan process identity checks outside the synchronous shared-state write section. */
export function observeAgentDatabaseLeasesForReconciliation(params: {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  agentId: string;
  path: string;
}): AgentDatabaseLeaseObservation {
  const agentId = normalizeAgentId(params.agentId);
  assertSingleAgentDatabaseReconciliationDomain(params);
  assertAgentDatabaseReconciliationAuthoritiesAbsent(params.database);
  const fileIdentity = agentDatabaseFileIdentity(params.path);
  const rows = readAgentDatabaseLeaseRows(params.database);
  const targetLeaseIds = new Set<string>();
  const deadLeaseIds = new Set<string>();
  for (const row of rows) {
    if (
      !row.lease_id ||
      !row.agent_id ||
      !row.path ||
      !Number.isSafeInteger(row.owner_pid) ||
      row.owner_pid <= 0 ||
      !Number.isSafeInteger(row.opened_at) ||
      row.opened_at < 0 ||
      (row.owner_start_time !== null &&
        (!Number.isSafeInteger(row.owner_start_time) || row.owner_start_time < 0))
    ) {
      throw new Error("Agent database lease identity is incomplete");
    }
    if (isPidDefinitelyDead(row.owner_pid)) {
      deadLeaseIds.add(row.lease_id);
      continue;
    }
    const start = getFileLockProcessStartTime(row.owner_pid);
    if (row.owner_start_time !== null && start !== null && row.owner_start_time !== start) {
      deadLeaseIds.add(row.lease_id);
      continue;
    }
    const sameFile = agentDatabaseFileIdentity(row.path) === fileIdentity;
    if (row.agent_id !== agentId || row.path !== params.path || !sameFile) {
      // Another store may have descendants even before its first registration
      // completes. Supported opens claim this shared-state lease before writing.
      throw new Error("Task reconciliation cannot fence another agent database domain");
    }
    targetLeaseIds.add(row.lease_id);
  }
  return { agentId, path: params.path, fileIdentity, rows, targetLeaseIds, deadLeaseIds };
}

/** Revalidate the complete census without pruning leases or opening an agent writer. */
export function assertAgentDatabaseLeaseObservationCurrent(params: {
  database: Pick<OpenClawStateDatabase, "db" | "path">;
  observation: AgentDatabaseLeaseObservation;
  ownsLocalLease: (leaseId: string) => boolean;
}): void {
  const { observation } = params;
  assertSingleAgentDatabaseReconciliationDomain({
    database: params.database,
    agentId: observation.agentId,
    path: observation.path,
  });
  assertAgentDatabaseReconciliationAuthoritiesAbsent(params.database);
  const current = readAgentDatabaseLeaseRows(params.database);
  if (
    JSON.stringify(current) !== JSON.stringify(observation.rows) ||
    agentDatabaseFileIdentity(observation.path) !== observation.fileIdentity
  ) {
    throw new Error("Agent database ownership changed during reconciliation");
  }
  for (const row of current) {
    if (
      observation.targetLeaseIds.has(row.lease_id) &&
      !observation.deadLeaseIds.has(row.lease_id) &&
      !params.ownsLocalLease(row.lease_id)
    ) {
      throw new Error("Agent database has another writable handle");
    }
  }
}

export const AGENT_DATABASE_MAINTENANCE_LEASE = {
  scope: "core:agent-database-maintenance",
  key: "global",
} as const;

const maintenanceAuthority = new AsyncLocalStorage<OpenClawStateLeaseContext>();

export function runWithAgentDatabaseMaintenanceAuthority<T>(
  authority: OpenClawStateLeaseContext,
  run: () => Promise<T>,
): Promise<T> {
  return maintenanceAuthority.run(authority, run);
}

/** Revalidate the held lease, including immediately before committing a versioned rebuild. */
export function assertAgentDatabaseMaintenanceAuthority(): void {
  const authority = maintenanceAuthority.getStore();
  if (!authority) {
    throw new Error(
      "Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.",
    );
  }
  authority.assertOwned();
}

export function claimOpenClawAgentDatabaseLease(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId, path: params.path },
    { env: params.env },
  );
  const leaseId = crypto.randomUUID();
  const ownerStartTime = getFileLockProcessStartTime(process.pid);
  runOpenClawStateWriteTransaction(
    (database) => {
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      const maintenance = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("state_leases")
          .select("owner")
          .where("scope", "=", AGENT_DATABASE_MAINTENANCE_LEASE.scope)
          .where("lease_key", "=", AGENT_DATABASE_MAINTENANCE_LEASE.key)
          .where("expires_at", ">", Date.now()),
      );
      if (maintenance) {
        throw new Error(
          "Agent database maintenance is in progress; retry after openclaw doctor --fix completes.",
        );
      }
      const deletion = executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("agent_deletion_journal").select("agent_id").where("agent_id", "=", agentId),
      );
      assertAgentDeletionIdentityClaimAllowed(agentId, deletion?.agent_id);
      assertAgentDeletionPathFence(database.db, deletionFence);
      executeSqliteQuerySync(
        database.db,
        db.insertInto("agent_database_leases").values({
          lease_id: leaseId,
          agent_id: agentId,
          path: params.path,
          owner_pid: process.pid,
          owner_start_time: ownerStartTime,
          opened_at: Date.now(),
        }),
      );
    },
    { env: params.env },
  );
  return leaseId;
}

export function releaseOpenClawAgentDatabaseLease(
  leaseId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("agent_database_leases").where("lease_id", "=", leaseId),
    );
  }, options);
}

export function assertNoOpenClawAgentDatabaseLeases(
  agentIdRaw: string | OpenClawStateLeaseContext,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const maintenance = typeof agentIdRaw === "string" ? undefined : agentIdRaw;
  const agentId = typeof agentIdRaw === "string" ? normalizeAgentId(agentIdRaw) : undefined;
  const rows = runOpenClawStateWriteTransaction((database) => {
    maintenance?.assertOwnedInTransaction(database.db);
    ensureAgentDatabaseLeaseSchema(database.db);
    const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("agent_database_leases")
        .select(["agent_id", "lease_id", "owner_pid", "owner_start_time", "path"]),
    ).rows;
  }, options);

  const staleLeaseIds = rows
    .filter((row) => {
      if (isPidDefinitelyDead(row.owner_pid)) {
        return true;
      }
      const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
      return (
        row.owner_start_time !== null &&
        currentStartTime !== null &&
        row.owner_start_time !== currentStartTime
      );
    })
    .map((row) => row.lease_id);
  if (staleLeaseIds.length > 0) {
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db.deleteFrom("agent_database_leases").where("lease_id", "in", staleLeaseIds),
      );
    }, options);
  }
  const staleLeaseIdSet = new Set(staleLeaseIds);
  for (const row of rows) {
    if (staleLeaseIdSet.has(row.lease_id)) {
      continue;
    }
    const deletionFence = agentId
      ? prepareAgentDeletionPathFence(
          { agentId: row.agent_id, path: row.path, fenceAgentId: agentId },
          options,
        )
      : undefined;
    let leaseStillExists = false;
    runOpenClawStateWriteTransaction((database) => {
      maintenance?.assertOwnedInTransaction(database.db);
      ensureAgentDatabaseLeaseSchema(database.db);
      const db = getNodeSqliteKysely<AgentDatabaseLeaseDatabase>(database.db);
      leaseStillExists =
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("agent_database_leases")
            .select("lease_id")
            .where("lease_id", "=", row.lease_id),
        ) !== undefined;
      if (leaseStillExists && row.agent_id !== agentId && deletionFence) {
        assertAgentDeletionPathFence(database.db, deletionFence);
      }
    }, options);
    if (leaseStillExists && (!agentId || row.agent_id === agentId)) {
      const remediation = agentId ? "." : "; stop that process and rerun openclaw doctor --fix.";
      throw new Error(
        `Agent ${row.agent_id} database is still open in another process${remediation}`,
      );
    }
  }
}
