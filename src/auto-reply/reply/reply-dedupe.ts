import { logVerbose, shouldLogVerbose } from "../../globals.js";
import type { MsgContext } from "../templating.js";

/**
 * Reply re-dispatch de-duplication.
 *
 * Tracks, per session, when the most recent reply landed. When the channel
 * ingress re-dispatches an errored turn (the same inbound messageId
 * re-presented into the session), a later dispatch can see that a reply
 * already landed *after* that inbound's original timestamp and suppress the
 * re-dispatch instead of re-running the turn.
 *
 * Session-scoping (rather than inbound-messageId-scoping) is deliberate: the
 * re-dispatched inbound is the *older* message being re-presented, while the
 * reply that suppresses it is a *newer* one that landed in the same session.
 * The guard compares the inbound's original timestamp against the reply's
 * landed time.
 *
 * This is distinct from `inbound-dedupe.ts`, which only guards against the
 * *same* inbound being delivered twice within a short window (20 min). Here we
 * guard against a *re-dispatch* of a turn whose reply already landed, which
 * can happen minutes (or longer) after the original delivery when a turn
 * errors with a pending reply.
 */

const DEFAULT_REPLY_DEDUPE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_REPLY_DEDUPE_MAX = 5000;

type ReplyLandedRecord = {
  landedAt: number;
};

const replyLandedBySession = new Map<string, ReplyLandedRecord>();

function prune(now: number): void {
  const cutoff = now - DEFAULT_REPLY_DEDUPE_TTL_MS;
  for (const [key, record] of replyLandedBySession) {
    if (record.landedAt < cutoff) {
      replyLandedBySession.delete(key);
    }
  }
  if (replyLandedBySession.size > DEFAULT_REPLY_DEDUPE_MAX) {
    const excess = replyLandedBySession.size - DEFAULT_REPLY_DEDUPE_MAX;
    let removed = 0;
    for (const key of replyLandedBySession.keys()) {
      if (removed >= excess) {
        break;
      }
      replyLandedBySession.delete(key);
      removed += 1;
    }
  }
}

/**
 * Resolve the session key used to scope the reply-landed record. Falls back to
 * the originating peer when no session key is present so that the guard still
 * applies in pre-session contexts.
 */
export function resolveReplyDedupeKey(ctx: MsgContext): string | null {
  const sessionKey = ctx.SessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const peer = (ctx.OriginatingTo ?? ctx.To ?? ctx.From)?.trim();
  return peer || null;
}

/**
 * Record that a reply landed for this session's inbound. Call after a final or
 * block reply is successfully queued/delivered for the inbound.
 *
 * The landed time is anchored to `Math.max(now, inboundTs)` so the record is
 * meaningful even when the inbound's original timestamp is ahead of the wall
 * clock (for example in tests with fixed timestamps). The guard only suppresses
 * an inbound that is strictly OLDER than the recorded landed time.
 */
export function recordReplyLanded(ctx: MsgContext, now = Date.now()): void {
  const key = resolveReplyDedupeKey(ctx);
  if (!key) {
    return;
  }
  const inboundTs =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : 0;
  const landedAt = Math.max(now, inboundTs);
  const existing = replyLandedBySession.get(key);
  replyLandedBySession.set(key, { landedAt: Math.max(existing?.landedAt ?? 0, landedAt) });
  prune(now);
}

/**
 * True when a reply already landed in this session at or after the inbound's
 * original timestamp, meaning the re-dispatched inbound is stale (the same
 * message re-presented) and should be suppressed rather than re-run.
 *
 * A genuinely NEW inbound carries a timestamp strictly after the landed reply,
 * so it is never suppressed. Returns false when the inbound carries no usable
 * timestamp (we cannot prove it is stale) so that a turn is not accidentally
 * suppressed.
 */
export function shouldSuppressReDispatch(ctx: MsgContext, now = Date.now()): boolean {
  const key = resolveReplyDedupeKey(ctx);
  if (!key) {
    return false;
  }
  const record = replyLandedBySession.get(key);
  if (!record || record.landedAt < now - DEFAULT_REPLY_DEDUPE_TTL_MS) {
    return false;
  }
  const inboundTs =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : null;
  if (inboundTs === null) {
    // No original timestamp: cannot prove the inbound is stale. Do not suppress.
    return false;
  }
  const suppressed = record.landedAt >= inboundTs;
  if (suppressed && shouldLogVerbose()) {
    logVerbose(
      `reply dedupe: suppressing re-dispatch for ${key} (inbound ts=${inboundTs} <= reply landedAt=${record.landedAt})`,
    );
  }
  return suppressed;
}

/** Test-only: clear all reply-landed records. */
export function resetReplyDedupe(): void {
  replyLandedBySession.clear();
}
