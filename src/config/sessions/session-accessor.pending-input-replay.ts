// The fork's answered-turn replay rule for re-presented user turns, split out of
// session-accessor.pending-inputs.ts (line cap). It owns the answered-turn marker: the
// request hash a run records when it reaches `final`, and the terminal test that reads it.
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "./restart-recovery-state.js";
import { preparePendingInputMessage } from "./session-accessor.pending-input-request.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type { PendingInputScope } from "./session-pending-input-store.js";
import type { SessionEntry } from "./types.js";

/** Bounded window for the answered-turn marker; mirrors the heartbeat duplicate guard. */
const COMPLETED_TURN_MARKER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Minted per inbound messageId by auto-reply/reply/source-turn-id.ts. */
const CHANNEL_USER_KEY_PREFIX = "channel-user:v1:";

/**
 * Request identity for one accepted user turn. Taken from the SUBMITTED message with
 * only `timestamp` removed, so it is computed before `prepareMessageAfterIdempotencyCheck`
 * (plugin hooks) and before `redactTranscriptMessageForStorage` ever run. It is therefore
 * NOT recoverable from committed transcript bytes: carriers must keep the stage-time value.
 */
export function computeSessionPendingInputRequestHash(
  message: PersistedUserTurnMessage,
  requestFingerprint?: string,
): string {
  // One definition with the stage path: the answered-turn marker must compare equal.
  return preparePendingInputMessage(message, requestFingerprint).requestHash;
}

/**
 * Record that the run carrying this request reached `final`. Fire-and-forget bookkeeping
 * after an already-succeeded turn: the patch re-reads the target and writes only while the
 * session id is unchanged, so a rotated session drops the marker instead of stamping a
 * stranger's entry. A lost write only re-admits a later re-presentation; it can never
 * retire a turn that was not answered.
 */
export async function recordSessionPendingInputCompletedTurn(
  scope: SessionAccessScope,
  options: { expectedSessionId: string; requestHash: string; completedAt?: number },
): Promise<void> {
  const completedAt = options.completedAt ?? Date.now();
  await patchSessionEntryCore(
    scope,
    (_entry, context) =>
      context.existingEntry?.sessionId === options.expectedSessionId
        ? {
            lastCompletedTurnRequestHash: options.requestHash,
            lastCompletedTurnAt: completedAt,
          }
        : null,
    { preserveActivity: true },
  );
}

/**
 * The session row the committed-turn terminal test reads after the stage snapshot. The worker
 * reader answers a captured session actor from its memory owner, so the host never opens an
 * actor-owned namespace itself.
 */
function readCommittedTurnSessionEntry(
  scope: PendingInputScope,
  sessionKey: string,
  assertCurrent: () => void,
): Promise<SessionEntry | undefined> {
  return readSessionEntryReadOnlyInWorker(
    { ...scope, sessionKey, readConsistency: "latest" },
    assertCurrent,
  );
}

/**
 * Classifies a re-presented user turn that matched a committed row: "answered" is terminal
 * (the caller consumes it), "admit" re-runs it, and "rotated" means the session row moved
 * after the stage snapshot, so the caller's admission is no longer current.
 */
export async function classifyCommittedPendingInputReplay(params: {
  scope: PendingInputScope;
  sessionKey: string;
  assertCurrent: () => void;
  idempotencyKey: string;
  requestHash: string;
  committedTimestamp: unknown;
}): Promise<"answered" | "admit" | "rotated"> {
  // A committed source turn is terminal at admission only when THIS request was
  // already ANSWERED - not merely committed. A re-presentation of an answered turn
  // and a re-drive of a turn that DIED mid-run both reach this branch with
  // `existing` null, the same idempotency key and identical bodies, so neither the
  // key's shape nor the run id separates them: every production caller of
  // stageApproved builds the key as `<runId>:user` from the same runId it passes,
  // which made the old key-ownership predicate always true and its consumed arm
  // dead code.
  //
  // The separating evidence is the answered-turn marker on the session entry,
  // written fire-and-forget only when a run reaches `final`. Consume only when the
  // marker names THIS request, was stamped at or after the committed message was
  // written, and is inside the bounded window; otherwise admit, so a died turn
  // still gets its answer. Two identical bodies under DIFFERENT idempotency keys
  // never meet here at all - they resolve to separate committed rows.
  // TWO RULES LIVE HERE, split by KEY SPACE, and they are deliberately not one.
  //
  // A channel-bound key (`channel-user:v1:<hash>`, minted per inbound messageId in
  // auto-reply/reply/source-turn-id.ts) is deterministic for one message, so a
  // committed hit under it is a re-drive by definition - body or not. A re-queued
  // update can arrive with its body LOST, which no content compare can see. It is
  // therefore terminal unless a pending, non-terminal restart-recovery claim must
  // re-deliver this exact source; a delivered-terminal receipt is a durable
  // "already delivered" outcome and does NOT authorize one.
  //
  // The arm is chosen by KEY SPACE, not by whose run id the key carries. Key ownership
  // was the predicate before this merge and it cannot decide this: an in-process retry
  // does arrive as "<runId>:user" under that same runId, but a retry that crosses a
  // RECORDER boundary carries the ORIGINAL run's key under a NEW run id (9ac9aecaa2d),
  // and so does restart recovery - both would read as "not mine" and be consumed.
  const { idempotencyKey, requestHash } = params;
  const channelBoundKey = idempotencyKey.startsWith(CHANNEL_USER_KEY_PREFIX);
  // v2026.10.1 builds the stage snapshot in the pending-input kernel (worker or native)
  // and reports only whether the session row is current; the restart-recovery claim and
  // the answered-turn marker live on that row, so the terminal test reads it here, AFTER
  // the snapshot. trackCompletion retries are admitted by the caller and never need it.
  const sessionEntry = await readCommittedTurnSessionEntry(
    params.scope,
    params.sessionKey,
    params.assertCurrent,
  );
  // A row that no longer names this session rotated after the snapshot, by a writer outside
  // this admission (another process). Deciding on its absent evidence re-ran answered
  // turns and consumed owed re-drives; like 9.9's single read, it is no longer current.
  if (sessionEntry?.sessionId !== params.scope.sessionId) {
    return "rotated";
  }
  // Recovery is an override on both arms: restart recovery re-drives a source turn
  // under a NEW recovery run id, so its key belongs to the ORIGINAL run and never to
  // this one. Consuming it there drops the legitimate re-delivery (#9's P1, and the
  // case PR #10's guard exists for). So a pending claim that still owes THIS source
  // keeps the replay admitted.
  //
  // A delivered-terminal receipt is a durable "already delivered" outcome that
  // coexists with the live claim until the atomic claim/tombstone cleanup, so it does
  // NOT authorize a re-drive; terminal-pending and delivery-ambiguous still do, by
  // design.
  //
  // Acknowledged window (adversarial review 2026-09-15): while a claim is live this
  // seam cannot tell the ingress watchdog's re-queue of that source from the recovery
  // dispatch's own redelivery, so it fails open (admit) toward recovery. The ambiguity
  // self-resolves once the claim clears (delivered-terminal / tombstone).
  //
  // Both key forms are matched because a claim records the source TURN id while the
  // replay may arrive as "<sourceTurnId>:user".
  const sourceTurnId = idempotencyKey.endsWith(":user")
    ? idempotencyKey.slice(0, -":user".length)
    : idempotencyKey;
  const requiresRecoveryRedelivery =
    sessionEntry?.restartRecoveryDeliveryReceiptState !== "delivered-terminal" &&
    (hasRestartRecoverySourceClaim(sessionEntry, idempotencyKey) ||
      hasRestartRecoverySourceClaim(sessionEntry, sourceTurnId)) &&
    !hasRestartRecoveryTerminalRun(sessionEntry, idempotencyKey) &&
    !hasRestartRecoveryTerminalRun(sessionEntry, sourceTurnId);
  // THE COLLAPSED RULE (b386f827465 required this of whoever merged it: two rules
  // lived at this seam, split by key space, and only one copy may survive).
  //
  // The key space decides WHICH question to ask, and the answer is one expression:
  //   channel-user:v1:<hash>  deterministic per inbound messageId, so a committed hit
  //                           is a re-drive by definition, body or not -> terminal,
  //                           unless a live claim still owes this source.
  //   everything else         run-id keys ("<runId>:user", every production
  //                           stageApproved caller) carry no such determinism: an
  //                           ANSWERED
  //                           turn and a re-drive of a turn that DIED mid-run arrive
  //                           identically. Answering "queued" whenever the key looked
  //                           like this run's (the predicate before this merge) meant
  //                           an answered turn re-ran; answering "consumed" would drop
  //                           a turn that died mid-run and never answer it at all. The
  //                           answered-turn marker is the only thing that separates
  //                           them, so it, not key ownership, is the terminal test.
  const completedTurnAt = sessionEntry?.lastCompletedTurnAt;
  const committedAt = typeof params.committedTimestamp === "number" ? params.committedTimestamp : 0;
  const now = Date.now();
  // Content-scoped and bounded, following the heartbeat repeated-relay guard
  // (37ea9f110ba): a stale or clock-skewed marker must not consume a live turn.
  const answeredAlready =
    sessionEntry?.lastCompletedTurnRequestHash === requestHash &&
    typeof completedTurnAt === "number" &&
    completedTurnAt >= committedAt &&
    completedTurnAt <= now &&
    now - completedTurnAt < COMPLETED_TURN_MARKER_WINDOW_MS;
  // 9.5's private-completion retries (trackCompletion) never reach this rule: the caller
  // admits them, because their completion is owned by the input-completion receipt.
  // The terminal rule is for re-presented USER turns only.
  return !requiresRecoveryRedelivery && (channelBoundKey || answeredAlready) ? "answered" : "admit";
}
