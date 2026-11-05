import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { loadExactSessionEntryReadOnly, upsertSessionEntryCore } from "./session-accessor.js";
import {
  computeSessionPendingInputRequestHash,
  recordSessionPendingInputCompletedTurn,
  stageSessionPendingInput,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// A committed source turn is only terminal at admission once some run carrying the
// SAME request reached `final`. Sibling file to session-accessor.pending-inputs.test.ts,
// which sits just under the repo max-lines cap.
//
// KEY SPACE MATTERS HERE. These cases use a run-id key (`<runId>:user`), which is what
// every production caller of stageApproved builds and what the answered-turn marker
// governs. The `channel-user:v1:` space has its own terminal-by-key arm, pinned by
// session-accessor.pending-inputs.redrive.test.ts - a fixture in that space would
// exercise that arm instead and never reach the marker.
describe("answered-turn marker at committed-input admission", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-completed-");
  const sessionKey = "agent:main:pending-inputs-completed";
  const sessionId = "pending-session-completed";
  const sourceTurnId = "first-run:user";
  const HOUR = 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const entryScope = () => ({ agentId: "main", sessionKey, storePath: fixture.storePath() });
  const sourceMessage = (timestamp: number): PersistedUserTurnMessage => ({
    role: "user",
    content: "Drive me once",
    timestamp,
    idempotencyKey: sourceTurnId,
  });
  const requestHash = computeSessionPendingInputRequestHash(sourceMessage(0));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
  });

  /** Commit the source turn the way its owning run would, then drop input custody. */
  const commitSourceTurn = async (timestamp: number) => {
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...scope(), sessionEntry: undefined },
      message: sourceMessage(timestamp),
    });
    expect(await recorder.stageApproved?.({ runId: "first-run", assertCurrent: () => {} })).toBe(
      true,
    );
    // The marker's hash is carried from staging: it is not recoverable afterwards.
    expect(recorder.getPendingInputRequestHash?.()).toBe(requestHash);
    await recorder.withPendingInput?.(() => recorder.persistApproved());
    recorder.finishPendingInput?.("interrupted");
  };

  /** The same committed source bytes arriving again under a NEW, unrelated run id. */
  const rePresent = () =>
    stageSessionPendingInput(scope(), {
      runId: "re-driven-run",
      message: sourceMessage(NOW),
      assertCurrent: () => {},
    });

  const stampMarker = (options: { requestHash: string; completedAt: number; sessionId?: string }) =>
    recordSessionPendingInputCompletedTurn(entryScope(), {
      expectedSessionId: options.sessionId ?? sessionId,
      requestHash: options.requestHash,
      completedAt: options.completedAt,
    });

  it("consumes a re-presentation once the answering run stamped its marker", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    await stampMarker({ requestHash, completedAt: NOW - HOUR });
    expect((await rePresent())?.state).toBe("consumed");
  });

  it("queues a re-presentation when no run ever reached final", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    expect(loadExactSessionEntryReadOnly(entryScope())?.entry?.lastCompletedTurnAt).toBeUndefined();
    expect((await rePresent())?.state).toBe("queued");
  });

  it("queues when the marker names a different request", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    await stampMarker({
      requestHash: computeSessionPendingInputRequestHash({
        ...sourceMessage(0),
        content: "A different question",
      }),
      completedAt: NOW - HOUR,
    });
    expect((await rePresent())?.state).toBe("queued");
  });

  it("queues when the marker predates the committed message", async () => {
    // Inside the 24h window, so only the ordering clause can reject it.
    await commitSourceTurn(NOW - 2 * HOUR);
    await stampMarker({ requestHash, completedAt: NOW - 3 * HOUR });
    expect((await rePresent())?.state).toBe("queued");
  });

  it("queues when the marker is older than the 24h window", async () => {
    // After the committed message, so only the window clause can reject it.
    await commitSourceTurn(NOW - 48 * HOUR);
    await stampMarker({ requestHash, completedAt: NOW - 25 * HOUR });
    expect((await rePresent())?.state).toBe("queued");
  });

  // Review finding (claude-air-opus5-f8e98e): every case above re-presents through
  // stageSessionPendingInput directly, so none of them crosses a RECORDER boundary. A
  // real retry builds a new recorder, and the key it carries decides whether the
  // committed row is found at all - if the key did not survive that boundary, the
  // branch is never entered and the marker is never consulted, whatever it says.
  it("consumes from a SECOND recorder instance, so the key survives the boundary", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    await stampMarker({ requestHash, completedAt: NOW - HOUR });
    const retry = createUserTurnTranscriptRecorder({
      target: { ...scope(), sessionEntry: undefined },
      message: sourceMessage(NOW),
    });
    // "consumed" is only reachable when the committed row was FOUND under this key.
    expect(await retry.stageApproved?.({ runId: "retry-run", assertCurrent: () => {} })).toBe(
      false,
    );
    expect(retry.isPendingInputConsumed?.()).toBe(true);
    retry.finishPendingInput?.("interrupted");
  });

  it("admits from a second recorder instance when the first run never answered", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    const retry = createUserTurnTranscriptRecorder({
      target: { ...scope(), sessionEntry: undefined },
      message: sourceMessage(NOW),
    });
    expect(await retry.stageApproved?.({ runId: "retry-run", assertCurrent: () => {} })).toBe(true);
    expect(retry.isPendingInputConsumed?.()).toBe(false);
    retry.finishPendingInput?.("interrupted");
  });

  it("writes no marker when the session id rotated before the patch", async () => {
    await commitSourceTurn(NOW - 2 * HOUR);
    await stampMarker({ requestHash, completedAt: NOW - HOUR, sessionId: "rotated-session" });
    const entry = loadExactSessionEntryReadOnly(entryScope())?.entry;
    expect(entry?.sessionId).toBe(sessionId);
    expect(entry?.lastCompletedTurnRequestHash).toBeUndefined();
    expect(entry?.lastCompletedTurnAt).toBeUndefined();
    expect((await rePresent())?.state).toBe("queued");
  });
});
