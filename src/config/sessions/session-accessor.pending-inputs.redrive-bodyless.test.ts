import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEvents, upsertSessionEntryCore } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// SCRATCH bounded repro (2026-09-14): body-LOST channel re-drive on the live 9.4-carry base.
// Mirrors session-accessor.pending-inputs.redrive.test.ts, but the re-drive arrives with
// its body lost (content "") — the shape the live Telegram ghosts take when the ingress
// watchdog re-queues a committed update. 9.4's isSourceTurnReplay content-compare cannot
// see these (content differs), so the question this repro settles: is the body-lost
// re-drive admitted as a FRESH agent turn at the committed-replay seam?
describe("committed source-turn re-drive, body lost", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-redrive-bodyless-");
  const sessionKey = "agent:main:pending-inputs-redrive-bodyless";
  const sessionId = "pending-session-redrive-bodyless";
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("re-drive of a committed channel source turn with a lost body", async () => {
    const target = { ...scope(), sessionEntry: undefined };
    const sourceTurnId = "channel-user:v1:cafe0000deadbeef0000";
    const sourceMessage: PersistedUserTurnMessage = {
      role: "user",
      content: "Drive me once",
      timestamp: 100,
      idempotencyKey: sourceTurnId,
    };
    const original = createUserTurnTranscriptRecorder({ target, message: sourceMessage });
    const originalStaged = await original.stageApproved?.({
      runId: "driven-run",
      assertCurrent: () => {},
    });
    expect(originalStaged).toBe(true);
    // The owning run executes: user message commits to the transcript, row consumed.
    await original.withPendingInput?.(() => original.persistApproved());
    const committedTranscript = await loadTranscriptEvents(scope());
    expect(
      committedTranscript.some(
        (event) =>
          asOptionalRecord(event)?.type === "message" &&
          asOptionalRecord(asOptionalRecord(event)?.message)?.idempotencyKey === sourceTurnId,
      ),
    ).toBe(true);
    original.finishPendingInput?.("interrupted");

    // RE-DRIVE: the SAME deterministic channel key (one inbound message), a NEW run id,
    // and a LOST body (content differs from the committed bytes).
    const reDriven = createUserTurnTranscriptRecorder({
      target,
      message: { ...sourceMessage, content: "", timestamp: 200 },
    });
    const reDrivenStaged = await reDriven.stageApproved?.({
      runId: "re-driven-run",
      assertCurrent: () => {},
    });
    // BASE (bug): true — admitted as a fresh agent turn (the ghost).
    // FIX: false — channel-bound committed hit is terminal at admission.
    expect(reDrivenStaged).toBe(false);
    reDriven.finishPendingInput?.("interrupted");
  });
});
