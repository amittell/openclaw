import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEvents, upsertSessionEntryCore } from "./session-accessor.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// Body-LOST channel re-drive, ported from PR #10 (fix/reinject-94-bodyless) onto the
// upgrade line, where the committed-replay seam is key-ownership (01f985cab95) rather
// than the carry's byte-compare.
// Mirrors session-accessor.pending-inputs.redrive.test.ts, but the re-drive arrives
// with its body lost (content "") - the shape the live Telegram ghosts take when the
// ingress watchdog re-queues a committed update. 9.4's isSourceTurnReplay
// content-compare cannot see these (content differs), so the question this repro
// settles: is the body-lost re-drive admitted as a FRESH agent turn at the
// committed-replay seam?
//
// The restart-recovery claim guard adds two edges:
//   - a delivered-terminal receipt (durable "already delivered") must NOT authorize
//     a re-drive;
//   - a terminal-pending / delivery-ambiguous receipt MUST still authorize one, so
//     legitimate restart recovery is preserved.
describe("committed source-turn re-drive, body lost", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-redrive-bodyless-");
  const sessionKey = "agent:main:pending-inputs-redrive-bodyless";
  const sessionId = "pending-session-redrive-bodyless";
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const sourceTurnId = "channel-user:v1:cafe0000deadbeef0000";
  const sourceMessage: PersistedUserTurnMessage = {
    role: "user",
    content: "Drive me once",
    timestamp: 100,
    idempotencyKey: sourceTurnId,
  };
  const commitSource = async () => {
    const target = { ...scope(), sessionEntry: undefined };
    const original = createUserTurnTranscriptRecorder({ target, message: sourceMessage });
    expect(await original.stageApproved?.({ runId: "driven-run", assertCurrent: () => {} })).toBe(
      true,
    );
    await original.withPendingInput?.(() => original.persistApproved());
    original.finishPendingInput?.("interrupted");
    expect(
      (await loadTranscriptEvents(scope())).some(
        (event) =>
          asOptionalRecord(event)?.type === "message" &&
          asOptionalRecord(asOptionalRecord(event)?.message)?.idempotencyKey === sourceTurnId,
      ),
    ).toBe(true);
  };
  const reDrive = async (runId: string) => {
    const target = { ...scope(), sessionEntry: undefined };
    const reDriven = createUserTurnTranscriptRecorder({
      target,
      message: { ...sourceMessage, content: "", timestamp: 200 },
    });
    const staged = await reDriven.stageApproved?.({ runId, assertCurrent: () => {} });
    reDriven.finishPendingInput?.("interrupted");
    return staged;
  };

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("re-drive of a committed channel source turn with a lost body", async () => {
    await commitSource();
    // No recovery claim: the body-lost channel re-drive is terminal (suppressed).
    // Key ownership already gives this: the key is a channel source turn id under an
    // unrelated run id.
    expect(await reDrive("re-driven-run")).toBe(false);
  });

  it("does not re-drive when the recovery receipt is already delivered-terminal", async () => {
    await commitSource();
    // A durable delivered-terminal receipt (already delivered) coexists with the live
    // claim until cleanup; it must NOT authorize a re-drive of this source.
    await upsertSessionEntryCore(scope(), {
      status: "failed",
      restartRecoveryDeliveryRequestFingerprint: "hmac-sha256:v1:test-fingerprint",
      restartRecoveryDeliveryRunId: "claim-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryReceiptState: "delivered-terminal",
      restartRecoverySourceIngress: "channel",
    });
    expect(await reDrive("re-driven-run-2")).toBe(false);
  });

  // PRE-FIX CONTROL on this line: key ownership consumes this, so the recovery is
  // DROPPED and this case fails on its assertion (expected true, got false).
  it("still re-drives when the recovery receipt is terminal-pending (legitimate recovery)", async () => {
    await commitSource();
    // A terminal-pending receipt means delivery is still in flight / ambiguous, so the
    // pending claim must authorize re-delivery of this exact source (queued).
    await upsertSessionEntryCore(scope(), {
      status: "failed",
      restartRecoveryDeliveryRequestFingerprint: "hmac-sha256:v1:test-fingerprint",
      restartRecoveryDeliveryRunId: "claim-run",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoverySourceIngress: "channel",
    });
    expect(await reDrive("re-driven-run-3")).toBe(true);
  });
});
