import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSqliteConnectionPragmas } from "../../infra/sqlite-wal.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  computeSessionPendingInputRequestHash,
  recordSessionPendingInputCompletedTurn,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// On v2026.10.1 the committed-replay decision reads two things at two moments: the
// pending-input snapshot (kernel, through the session worker) and THEN the session entry
// (`loadSessionEntryReadOnly`, main thread) for the answered-turn marker and the
// restart-recovery claim. 9.9 read both in one synchronous block. These cases hold that
// gap open after the snapshot resolves and write the entry inside it.
//
// Two writers: an in-process one through the public API (it queues on the agent-database
// write admission the stage holds), and a second SQLite connection, which is what another
// process sharing the agent database is (the precedent is the external-race writer in
// session-accessor.sqlite-data-version.test.ts).
const gate = vi.hoisted(() => ({
  afterStageRead: undefined as ((databasePath: string) => Promise<void>) | undefined,
}));

vi.mock("./session-pending-input-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-pending-input-store.js")>();
  return {
    ...actual,
    preparePendingInputStore: async (
      ...args: Parameters<typeof actual.preparePendingInputStore>
    ) => {
      const store = await actual.preparePendingInputStore(...args);
      return {
        ...store,
        read: async (input: Parameters<typeof store.read>[0]) => {
          const snapshot = await store.read(input);
          if (input.kind === "stage" && gate.afterStageRead) {
            await gate.afterStageRead(store.path);
          }
          return snapshot;
        },
      };
    },
  };
});

describe("committed-replay decision against an entry write between snapshot and entry read", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-entry-race-");
  const sessionKey = "agent:main:pending-inputs-entry-race";
  const sessionId = "pending-session-entry-race";
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
  const runKey = "first-run:user";
  const channelKey = "channel-user:v1:entry-race";
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const entryScope = () => ({ agentId: "main", sessionKey, storePath: fixture.storePath() });
  const sourceMessage = (idempotencyKey: string, timestamp: number): PersistedUserTurnMessage => ({
    role: "user",
    content: "Drive me once",
    timestamp,
    idempotencyKey,
  });
  const requestHash = computeSessionPendingInputRequestHash(sourceMessage(runKey, 0));
  const receipts: SessionPendingInputReceipt[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(async () => {
    gate.afterStageRead = undefined;
    for (const receipt of receipts.splice(0)) {
      receipt.finish("interrupted");
      await receipt.settled?.();
    }
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
  });

  /** Commit the source turn the way its owning run would, then drop input custody. */
  const commitSourceTurn = async (idempotencyKey: string) => {
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope(), sessionEntry: undefined },
      message: sourceMessage(idempotencyKey, NOW - 2 * HOUR),
    });
    expect(await recorder.stageApproved?.({ runId: "first-run", assertCurrent: () => {} })).toBe(
      true,
    );
    await recorder.withPendingInput?.(() => recorder.persistApproved());
    recorder.finishPendingInput?.("interrupted");
  };

  /** The same committed source arriving again under a new run id (watchdog or retry). */
  const rePresent = async (idempotencyKey: string) => {
    const receipt = await stageSessionPendingInput(scope(), {
      runId: "re-driven-run",
      message: sourceMessage(idempotencyKey, NOW),
      assertCurrent: () => {},
    });
    if (receipt) {
      receipts.push(receipt);
    }
    return receipt;
  };

  const stampMarker = () =>
    recordSessionPendingInputCompletedTurn(entryScope(), {
      expectedSessionId: sessionId,
      requestHash,
      completedAt: NOW - HOUR,
    });

  /** A second SQLite connection: another process sharing this agent database. */
  const externalWrite = (databasePath: string, sql: string, ...values: (string | number)[]) => {
    const external = new DatabaseSync(databasePath);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "pending-input-entry-race-writer",
      databasePath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      // The triggers clear `entry_valid` on any entry write; a real writer restores its
      // proof in the same transaction (session-accessor.sqlite-entry-write-queries.ts).
      external.exec("BEGIN IMMEDIATE");
      external.prepare(sql).run(...values, sessionKey);
      external
        .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
        .run(sessionKey);
      external.exec("COMMIT");
    } finally {
      maintenance.close();
      external.close();
    }
  };
  const rawEntry = (databasePath: string) => {
    const external = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = external
        .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey) as { entry_json: string } | undefined;
      return row ? (JSON.parse(row.entry_json) as Record<string, unknown>) : undefined;
    } finally {
      external.close();
    }
  };
  const rotateSql =
    "UPDATE session_nodes SET current_session_id = ?, entry_json = json_set(entry_json, '$.sessionId', ?) WHERE session_key = ?";
  const rotate = (databasePath: string) =>
    externalWrite(databasePath, rotateSql, "rotated-session", "rotated-session");

  /** Run one re-presentation with `write` executed after its snapshot, before its entry read. */
  const rePresentWithWriteInGap = async (
    idempotencyKey: string,
    write: (databasePath: string) => void,
  ) => {
    let wrote = false;
    gate.afterStageRead = async (databasePath) => {
      gate.afterStageRead = undefined;
      write(databasePath);
      wrote = true;
    };
    const receipt = await rePresent(idempotencyKey);
    expect(wrote).toBe(true);
    return receipt;
  };

  /** Hold the next stage in the gap until `close`; `opened` resolves with its database. */
  const holdGap = () => {
    let close!: () => void;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const opened = new Promise<string>((resolve) => {
      gate.afterStageRead = async (databasePath) => {
        gate.afterStageRead = undefined;
        resolve(databasePath);
        await closed;
      };
    });
    return { opened, close };
  };
  /** Give a queued writer every chance to run: event-loop turns, then wall time. */
  const letWritersRun = async () => {
    for (let turn = 0; turn < 20; turn++) {
      await nextTurn();
    }
    await sleep(50);
  };

  it("queues an in-process marker write behind the stage, so it never lands in the gap", async () => {
    await commitSourceTurn(runKey);
    const gap = holdGap();
    const staging = rePresent(runKey);
    const databasePath = await gap.opened;
    // Launched from this test's own async context, as a finishing run's fire-and-forget is.
    const marker = stampMarker();
    await letWritersRun();
    expect(rawEntry(databasePath)?.lastCompletedTurnRequestHash).toBeUndefined();
    gap.close();
    expect((await staging)?.state).toBe("queued");
    await marker;
    expect(rawEntry(databasePath)?.lastCompletedTurnRequestHash).toBe(requestHash);
  });

  it("queues an in-process session rotation behind the stage, so it never lands in the gap", async () => {
    await commitSourceTurn(runKey);
    await stampMarker();
    const gap = holdGap();
    const staging = rePresent(runKey);
    const databasePath = await gap.opened;
    const rotation = upsertSessionEntryCore(scope(), { sessionId: "rotated-session" });
    await letWritersRun();
    expect(rawEntry(databasePath)?.sessionId).toBe(sessionId);
    gap.close();
    expect((await staging)?.state).toBe("consumed");
    await rotation;
    expect(rawEntry(databasePath)?.sessionId).toBe("rotated-session");
  });

  it("an external marker write in the gap is seen, as if it preceded the stage", async () => {
    await commitSourceTurn(runKey);
    const receipt = await rePresentWithWriteInGap(runKey, (databasePath) =>
      externalWrite(
        databasePath,
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lastCompletedTurnRequestHash', ?, '$.lastCompletedTurnAt', ?) WHERE session_key = ?",
        requestHash,
        NOW - HOUR,
      ),
    );
    expect(receipt?.state).toBe("consumed");
  });

  it("an external recovery claim in the gap keeps a channel re-drive admitted", async () => {
    await commitSourceTurn(channelKey);
    const receipt = await rePresentWithWriteInGap(channelKey, (databasePath) =>
      externalWrite(
        databasePath,
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.restartRecoveryDeliveryRunId', ?, '$.restartRecoveryDeliverySourceRunId', ?) WHERE session_key = ?",
        "recovery-run",
        channelKey,
      ),
    );
    expect(receipt?.state).toBe("queued");
  });

  it("an external delivered-terminal receipt in the gap ends the claim's override", async () => {
    await commitSourceTurn(channelKey);
    await upsertSessionEntryCore(scope(), {
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: channelKey,
    });
    expect((await rePresent(channelKey))?.state).toBe("queued");
    const receipt = await rePresentWithWriteInGap(channelKey, (databasePath) =>
      externalWrite(
        databasePath,
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.restartRecoveryDeliveryReceiptState', ?) WHERE session_key = ?",
        "delivered-terminal",
      ),
    );
    expect(receipt?.state).toBe("consumed");
  });

  // The one write the snapshot ALSO reads is the session's currency. Serially a rotation
  // either precedes the stage (snapshot not current -> undefined) or follows it (the
  // answered marker consumes); neither runs the turn again.
  it("a rotation before the stage, or after it, never re-runs an answered turn", async () => {
    await commitSourceTurn(runKey);
    await stampMarker();
    let databasePath = "";
    // Serially AFTER: the answered marker consumes (this gap write only records the path).
    const after = await rePresentWithWriteInGap(runKey, (path) => {
      databasePath = path;
    });
    expect(after?.state).toBe("consumed");
    // Serially BEFORE: the snapshot itself reports the session as no longer current.
    rotate(databasePath);
    expect(await rePresent(runKey)).toBeUndefined();
  });

  it("a rotation before the stage, or after it, never consumes an owed channel re-drive", async () => {
    await commitSourceTurn(channelKey);
    await upsertSessionEntryCore(scope(), {
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: channelKey,
    });
    let databasePath = "";
    const after = await rePresentWithWriteInGap(channelKey, (path) => {
      databasePath = path;
    });
    expect(after?.state).toBe("queued");
    rotate(databasePath);
    expect(await rePresent(channelKey)).toBeUndefined();
  });

  // In the gap the entry no longer names the session the snapshot proved current. Read as
  // absent evidence, that queued a fresh agent turn for an answered message and consumed a
  // re-drive a live claim owes - outcomes no serial order produces. It reads as not current.
  it("a rotation in the gap reads as not current instead of re-running an answered turn", async () => {
    await commitSourceTurn(runKey);
    await stampMarker();
    const receipt = await rePresentWithWriteInGap(runKey, rotate);
    expect(receipt?.state).toBeUndefined();
  });

  it("a rotation in the gap reads as not current instead of consuming an owed re-drive", async () => {
    await commitSourceTurn(channelKey);
    await upsertSessionEntryCore(scope(), {
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: channelKey,
    });
    const receipt = await rePresentWithWriteInGap(channelKey, rotate);
    expect(receipt?.state).toBeUndefined();
  });
});
