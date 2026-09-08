import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTaskOwnership, upsertSessionEntryCore } from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

const root = "agent:main:subagent:orphan";
const child = "agent:main:subagent:descendant";

describe("strict retained task session ownership", () => {
  it("includes empty old windows and descendants reparented in their current window", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore({ sessionKey: root }, { sessionId: "root-old", updatedAt: 1 });
      await upsertSessionEntryCore({ sessionKey: root }, { sessionId: "root-new", updatedAt: 2 });
      await upsertSessionEntryCore(
        { sessionKey: child },
        { sessionId: "child-old", updatedAt: 1, spawnedBy: root },
      );
      await upsertSessionEntryCore(
        { sessionKey: child },
        { sessionId: "child-new", updatedAt: 2, spawnedBy: "agent:main:other" },
      );
      const warm = readSessionTaskOwnership({ sessionKey: root });
      expect(warm.sessionKeys).toEqual([child, root].toSorted());
      expect(warm.sessionIds.toSorted()).toEqual([
        "child-new",
        "child-old",
        "root-new",
        "root-old",
      ]);
      closeOpenClawAgentDatabasesForTest();
      const fresh = readSessionTaskOwnership({ sessionKey: root });
      expect(fresh.signature).toBe(warm.signature);
      expect(fresh.localDatabase).toBeUndefined();
    });
  });

  it.each(["entry-valid", "promoted-parent"])(
    "rejects %s corruption after warming the canonical cache and on a fresh reader",
    async (corruption) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(
          { sessionKey: root },
          { sessionId: "root-window", updatedAt: 1 },
        );
        expect(readSessionTaskOwnership({ sessionKey: root }).entry.sessionId).toBe("root-window");
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .updateTable("session_nodes")
            .set(
              corruption === "entry-valid"
                ? { entry_valid: 0 }
                : { spawned_by: "agent:main:other" },
            )
            .where("session_key", "=", root),
        );
        expect(() => readSessionTaskOwnership({ sessionKey: root })).toThrow(/requires repair/);
        closeOpenClawAgentDatabasesForTest();
        expect(() => readSessionTaskOwnership({ sessionKey: root })).toThrow(/requires repair/);
      });
    },
  );

  it("does not hide a pending same-handle transaction behind a fresh reader", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { sessionKey: root },
        { sessionId: "root-window", updatedAt: 1 },
      );
      runOpenClawAgentWriteTransaction(
        () => {
          expect(() => readSessionTaskOwnership({ sessionKey: root })).toThrow(/in-flight/);
        },
        { agentId: "main" },
      );
    });
  });

  it("rejects an incomplete retained previous-window chain", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(
        { sessionKey: root },
        { sessionId: "root-window", updatedAt: 1 },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .updateTable("session_windows")
          .set({ previous_session_id: "missing-window" })
          .where("session_id", "=", "root-window"),
      );
      expect(() => readSessionTaskOwnership({ sessionKey: root })).toThrow(/incomplete/);
    });
  });
});
