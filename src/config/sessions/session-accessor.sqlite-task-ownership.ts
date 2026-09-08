// Strict retained session lineage for owner-mediated task reconciliation.
import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveSessionStorePathCore } from "./paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { parseReadableSqliteSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  assertCanonicalSessionKeyWrite,
  scanCanonicalSqliteSessionEntries,
} from "./session-canonical-key.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "./store-writer-state.js";
import type { SessionEntry } from "./types.js";

export type SessionTaskOwnershipObservation = {
  agentId: string;
  databasePath: string;
  storePath: string;
  localDatabase?: OpenClawAgentDatabase;
  sessionKey: string;
  entry: SessionEntry;
  sessionKeys: readonly string[];
  sessionIds: readonly string[];
  signature: string;
};

/** Read every retained window and local descendant, including windows without transcripts. */
export function readSessionTaskOwnership(
  scope: SessionAccessScope,
): SessionTaskOwnershipObservation {
  const storePath = resolveSessionStorePathForScope(scope);
  const resolved = resolveSqliteScope({ ...scope, storePath });
  assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
  const options = toDatabaseOptions(resolved);
  const expectedPath = resolveOpenClawAgentSqlitePath({
    agentId: resolved.agentId,
    env: options.env,
  });
  if (
    resolveOpenClawAgentSqlitePath(options) !== expectedPath ||
    storePath !==
      resolveSessionStorePathCore(undefined, { agentId: resolved.agentId, env: options.env })
  ) {
    throw new Error("Task reconciliation requires the canonical agent database lease domain");
  }
  const localDatabase = getOpenClawAgentDatabaseIfOpen(options);
  // Retained queued writes may outlive an admission or await while owning this store.
  for (const queue of SQLITE_SESSION_WRITER_QUEUES.values()) {
    if (queue.pending.length || queue.drainPromise) {
      throw new Error("Task reconciliation cannot pass an outstanding session store writer");
    }
  }
  if (localDatabase?.db.isTransaction) {
    throw new Error("Task reconciliation cannot observe an in-flight agent transaction");
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      scanCanonicalSqliteSessionEntries(database);
      const db = getSessionKysely(database.db);
      const nodes = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_nodes").selectAll().orderBy("session_key"),
      ).rows;
      const entries = new Map<string, SessionEntry>();
      for (const node of nodes) {
        assertCanonicalSessionKeyWrite(node.session_key, resolved.agentId);
        const entry = parseReadableSqliteSessionEntryRow(database, node);
        if (node.entry_valid === -1 && node.entry_json === "{}") {
          continue;
        }
        if (!entry || entry.sessionId !== node.current_session_id) {
          throw new Error("Task reconciliation session lineage is incomplete");
        }
        entries.set(node.session_key, entry);
      }
      const allWindows = executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_windows").selectAll().orderBy("session_id"),
      ).rows;
      for (const window of allWindows) {
        assertCanonicalSessionKeyWrite(window.session_key, resolved.agentId);
        for (const parent of [window.parent_session_key, window.spawned_by]) {
          if (parent !== null) {
            assertCanonicalSessionKeyWrite(parent);
          }
        }
      }
      const selectedKeys = new Set([resolved.sessionKey]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const node of [...nodes, ...allWindows]) {
          if (
            !selectedKeys.has(node.session_key) &&
            ((node.parent_session_key !== null && selectedKeys.has(node.parent_session_key)) ||
              (node.spawned_by !== null && selectedKeys.has(node.spawned_by)))
          ) {
            selectedKeys.add(node.session_key);
            changed = true;
          }
        }
      }
      const selectedNodes = nodes.filter((node) => selectedKeys.has(node.session_key));
      const entry = entries.get(resolved.sessionKey);
      if (!entry) {
        throw new Error("Task reconciliation requires a canonical backing session");
      }
      const sessionKeys = [...selectedKeys].toSorted();
      const windows = allWindows.filter((window) => selectedKeys.has(window.session_key));
      const pendingInputs = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_pending_inputs")
          .select("input_id")
          .where("session_key", "in", sessionKeys),
      ).rows;
      if (pendingInputs.length) {
        throw new Error("Task reconciliation retains pending input ownership");
      }
      const windowById = new Map(windows.map((window) => [window.session_id, window]));
      for (const node of selectedNodes) {
        if (windowById.get(node.current_session_id)?.session_key !== node.session_key) {
          throw new Error("Task reconciliation cannot bind the current retained window");
        }
      }
      for (const window of windows) {
        if (
          !window.session_id ||
          window.acp_owned !== 0 ||
          window.plugin_owner_id !== null ||
          (window.previous_session_id !== null && !windowById.has(window.previous_session_id))
        ) {
          throw new Error("Task reconciliation window ownership is incomplete");
        }
        const visited = new Set<string>();
        let current: typeof window | undefined = window;
        while (current) {
          if (visited.has(current.session_id)) {
            throw new Error("Task reconciliation window lineage is cyclic");
          }
          visited.add(current.session_id);
          current = current.previous_session_id
            ? windowById.get(current.previous_session_id)
            : undefined;
        }
      }
      return {
        agentId: resolved.agentId,
        databasePath: database.path,
        storePath,
        ...(localDatabase ? { localDatabase } : {}),
        sessionKey: resolved.sessionKey,
        entry,
        sessionKeys,
        sessionIds: [...windowById.keys()],
        signature: createHash("sha256")
          .update(JSON.stringify({ nodes: selectedNodes, windows }))
          .digest("hex"),
      } satisfies SessionTaskOwnershipObservation;
    },
    options,
    { throwOnMissingTable: true },
  );
  if (!result.found) {
    throw new Error("Task reconciliation session database is unavailable");
  }
  return result.value;
}
