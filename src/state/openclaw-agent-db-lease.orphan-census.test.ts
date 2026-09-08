import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  assertAgentDatabaseLeaseObservationCurrent,
  claimOpenClawAgentDatabaseLease,
  observeAgentDatabaseLeasesForReconciliation,
  releaseOpenClawAgentDatabaseLease,
  type AgentDatabaseLeaseObservation,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  ownsOpenClawAgentDatabaseLease,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { withOpenClawStateLease } from "./openclaw-state-lease.js";

function fixture() {
  const agent = openOpenClawAgentDatabase({ agentId: "main" });
  const database = openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<Pick<DB, "agent_database_leases" | "state_leases">>(database.db);
  const observe = () =>
    observeAgentDatabaseLeasesForReconciliation({
      database,
      agentId: agent.agentId,
      path: agent.path,
    });
  const ownsLocalLease = (leaseId: string) =>
    ownsOpenClawAgentDatabaseLease({
      database: agent,
      statePath: database.path,
      leaseId,
    });
  const assertCurrent = (observation: AgentDatabaseLeaseObservation) =>
    runOpenClawStateWriteTransaction(
      (current) =>
        assertAgentDatabaseLeaseObservationCurrent({
          database: current,
          observation,
          ownsLocalLease,
        }),
      { database },
    );
  const readRows = () =>
    executeSqliteQuerySync(
      database.db,
      db.selectFrom("agent_database_leases").selectAll().orderBy("lease_id"),
    ).rows;
  const claimForeignLease = () =>
    claimOpenClawAgentDatabaseLease({ agentId: agent.agentId, path: agent.path });
  return {
    agent,
    database,
    db,
    observe,
    ownsLocalLease,
    assertCurrent,
    readRows,
    claimForeignLease,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("current orphan writable-handle census", () => {
  it("exempts only the exact idle cached handle in its authoritative state domain", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { agent, database, observe, assertCurrent, ownsLocalLease } = fixture();
      const observation = observe();
      expect(observation.targetLeaseIds.size).toBe(1);
      const leaseId = [...observation.targetLeaseIds][0]!;
      expect(ownsLocalLease(leaseId)).toBe(true);
      expect(() => assertCurrent(observation)).not.toThrow();
      expect(
        ownsOpenClawAgentDatabaseLease({
          database: { ...agent },
          statePath: database.path,
          leaseId,
        }),
      ).toBe(false);
      expect(
        ownsOpenClawAgentDatabaseLease({
          database: agent,
          statePath: state.path("other-state.sqlite"),
          leaseId,
        }),
      ).toBe(false);
      runOpenClawAgentWriteTransaction(
        () => {
          expect(ownsLocalLease(leaseId)).toBe(false);
          expect(() => assertCurrent(observation)).toThrow(/another writable handle/);
        },
        { agentId: "main" },
      );
      expect(ownsLocalLease(leaseId)).toBe(true);
      closeOpenClawAgentDatabaseByPath(agent.path);
      expect(ownsLocalLease(leaseId)).toBe(false);
    });
  });

  it("retains a real worker-thread writable handle with the same PID and process start", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { agent, observe, assertCurrent, readRows, ownsLocalLease } = fixture();
      const before = readRows();
      const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          const { tsImport } = await import(workerData.tsx);
          const owner = await tsImport(workerData.moduleURL, {
            parentURL: workerData.parentURL, tsconfig: workerData.tsconfig,
          });
          const database = owner.openOpenClawAgentDatabase({ agentId: "main" });
          parentPort.once("message", () => {
            owner.closeOpenClawAgentDatabasesForTest();
            parentPort.close();
          });
          parentPort.postMessage({ ownerPid: process.pid, path: database.path, open: database.db.isOpen });
        })().catch((error) => { throw error; });
      `,
        {
          eval: true,
          execArgv: [],
          workerData: {
            tsx: import.meta.resolve("tsx/esm/api"),
            moduleURL: new URL("./openclaw-agent-db.ts", import.meta.url).href,
            parentURL: import.meta.url,
            tsconfig: path.resolve("tsconfig.json"),
          },
        },
      );
      try {
        const [message] = await once(worker, "message");
        expect(message).toEqual({ ownerPid: process.pid, path: agent.path, open: true });
        const rows = readRows();
        const foreign = rows.find(
          (row) => !before.some((prior) => prior.lease_id === row.lease_id),
        );
        expect(foreign).toBeDefined();
        expect(foreign?.owner_pid).toBe(before[0]?.owner_pid);
        expect(foreign?.owner_start_time).toBe(before[0]?.owner_start_time);
        expect(ownsLocalLease(foreign!.lease_id)).toBe(false);
        expect(() => assertCurrent(observe())).toThrow(/another writable handle/);
        expect(readRows()).toEqual(rows);
        const exited = once(worker, "exit");
        worker.postMessage("close", []);
        expect(await exited).toEqual([0]);
        expect(readRows()).toEqual(before);
        expect(() => assertCurrent(observe())).not.toThrow();
      } finally {
        await worker.terminate();
      }
    });
  }, 20_000);

  it("retains a lease when the cached handle's close failed", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { agent, observe, assertCurrent, readRows } = fixture();
      const rows = readRows();
      const close = vi.spyOn(agent.walMaintenance, "close").mockImplementationOnce(() => {
        throw new Error("owned fixture close failed");
      });
      try {
        expect(() => closeOpenClawAgentDatabaseByPath(agent.path)).toThrow(
          "owned fixture close failed",
        );
        expect(agent.db.isOpen).toBe(true);
        expect(() => assertCurrent(observe())).toThrow(/another writable handle/);
        expect(readRows()).toEqual(rows);
      } finally {
        close.mockRestore();
        closeOpenClawAgentDatabaseByPath(agent.path);
      }
    });
  });

  it("retains an owner when process liveness and start identity are unknown", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { claimForeignLease, observe, assertCurrent, readRows } = fixture();
      const leaseId = claimForeignLease();
      try {
        const rows = readRows();
        vi.spyOn(pidAlive, "isPidDefinitelyDead").mockReturnValue(false);
        vi.spyOn(pidAlive, "getFileLockProcessStartTime").mockReturnValue(null);
        expect(() => assertCurrent(observe())).toThrow(/another writable handle/);
        expect(readRows()).toEqual(rows);
      } finally {
        releaseOpenClawAgentDatabaseLease(leaseId);
      }
    });
  });

  it.each([0, -1])(
    "rejects malformed PID %s instead of interpreting it as a dead owner",
    async (ownerPid) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { claimForeignLease, database, db, observe, readRows } = fixture();
        const leaseId = claimForeignLease();
        try {
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("agent_database_leases")
              .set({ owner_pid: ownerPid })
              .where("lease_id", "=", leaseId),
          );
          const rows = readRows();
          expect(() => observe()).toThrow(/identity is incomplete/);
          expect(readRows()).toEqual(rows);
        } finally {
          releaseOpenClawAgentDatabaseLease(leaseId);
        }
      });
    },
  );

  it("can ignore a proven exited owner without pruning its durable lease", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { claimForeignLease, database, db, observe, assertCurrent, readRows } = fixture();
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      expect(await once(child, "exit")).toEqual([0, null]);
      expect(child.pid).toBeTypeOf("number");
      const leaseId = claimForeignLease();
      try {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("agent_database_leases")
            .set({ owner_pid: child.pid!, owner_start_time: null })
            .where("lease_id", "=", leaseId),
        );
        const rows = readRows();
        const observation = observe();
        expect(observation.deadLeaseIds.has(leaseId)).toBe(true);
        expect(() => assertCurrent(observation)).not.toThrow();
        expect(readRows()).toEqual(rows);
      } finally {
        releaseOpenClawAgentDatabaseLease(leaseId);
      }
    });
  });

  it.each(["new-lease", "changed-row"])("rejects %s introduced after observation", async (race) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { claimForeignLease, database, db, observe, assertCurrent, readRows } = fixture();
      const observation = observe();
      const foreignId = race === "new-lease" ? claimForeignLease() : undefined;
      try {
        if (race === "changed-row") {
          const row = readRows()[0]!;
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("agent_database_leases")
              .set({ opened_at: row.opened_at + 1 })
              .where("lease_id", "=", row.lease_id),
          );
        }
        const rows = readRows();
        expect(() => assertCurrent(observation)).toThrow(/ownership changed/);
        expect(readRows()).toEqual(rows);
      } finally {
        if (foreignId) {
          releaseOpenClawAgentDatabaseLease(foreignId);
        }
      }
    });
  });

  it("rejects a database file replaced after observing an empty writable census", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { agent, observe, assertCurrent } = fixture();
      closeOpenClawAgentDatabaseByPath(agent.path);
      const observation = observe();
      const replacement = state.path("replacement.sqlite");
      fs.copyFileSync(agent.path, replacement);
      fs.renameSync(replacement, agent.path);
      expect(() => assertCurrent(observation)).toThrow(/ownership changed/);
    });
  });

  it.each([false, true])(
    "retains a maintenance authority even when its recorded expiry passed=%s",
    async (expired) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { database, db, observe, assertCurrent } = fixture();
        const observation = observe();
        let retentionChecked = false;
        const operation = withOpenClawStateLease(
          {
            ...AGENT_DATABASE_MAINTENANCE_LEASE,
            database: { scope: "shared" },
            leaseMs: 60_000,
            waitMs: 0,
          },
          async () => {
            if (expired) {
              executeSqliteQuerySync(
                database.db,
                db
                  .updateTable("state_leases")
                  .set({ expires_at: 1 })
                  .where("scope", "=", AGENT_DATABASE_MAINTENANCE_LEASE.scope)
                  .where("lease_key", "=", AGENT_DATABASE_MAINTENANCE_LEASE.key),
              );
            }
            expect(() => observe()).toThrow(/maintenance or deletion owner/);
            expect(() => assertCurrent(observation)).toThrow(/maintenance or deletion owner/);
            retentionChecked = true;
          },
        );
        if (expired) {
          await expect(operation).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
        } else {
          await expect(operation).resolves.toBeUndefined();
        }
        expect(retentionChecked).toBe(true);
      });
    },
  );

  it("retains another agent's deletion authority that overlaps the target database", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { observe, assertCurrent } = fixture();
      const observation = observe();
      const deletion = beginAgentDeletion({
        agentId: "other",
        agentDir: state.stateDir,
        workspaceDir: state.workspaceDir,
        sessionsDir: state.sessionsDir("other"),
      });
      try {
        expect(() => observe()).toThrow(/maintenance or deletion owner/);
        expect(() => assertCurrent(observation)).toThrow(/maintenance or deletion owner/);
      } finally {
        deletion.rollback();
      }
      expect(() => assertCurrent(observation)).not.toThrow();
    });
  });

  it("does not reopen an unreadable census as an empty observation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { agent, database } = fixture();
      const reader = openNodeSqliteDatabase(database.path, { readOnly: true });
      reader.close();
      expect(() =>
        observeAgentDatabaseLeasesForReconciliation({
          database: { db: reader, path: database.path },
          agentId: agent.agentId,
          path: agent.path,
        }),
      ).toThrow(/database is not open/);
    });
  });
});
