import { logVerbose, shouldLogVerbose } from "../../globals.js";
import type { MsgContext } from "../templating.js";

/**
 * Reply re-dispatch de-duplication.
 *
 * Tracks, per session, which inbound message ids already have a landed reply.
 * When the channel ingress re-dispatches an errored turn, the spool re-presents
 * the SAME provider messageId into the session; if a reply already landed for
 * that exact id, the re-dispatch is suppressed instead of re-running the turn.
 *
 * Suppression is identity-based (session + provider messageId), not
 * timestamp-based: the inbound's `Timestamp` is the provider's message-creation
 * time (Telegram is only second-resolution), not the dispatch start time. A
 * genuinely new message sent while a prior turn is still running can therefore
 * carry a timestamp older than the landed reply and must NOT be treated as a
 * re-presentation. Only a re-presented id can be proven stale.
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
 * Resolve the stable provider message id for the inbound, if any. The ingress
 * spool re-presents the same id on re-dispatch, so this is the identity that
 * proves a re-presentation. Mirrors the resolution used for hooks and ACP
 * request ids.
 */
export function resolveInboundMessageId(ctx: MsgContext): string | null {
  const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  if (typeof id === "number" || typeof id === "bigint") {
    return String(id);
  }
  return null;
}

/**
 * Record that a reply landed for this inbound. Call after a final or block
 * reply is successfully queued/delivered for the inbound (embedded and ACP
 * delivery paths alike).
 *
 * Requires both a session key and a stable provider message id; without an
 * identity there is nothing to correlate a re-presentation against, so the
 * record is skipped (and the guard will not suppress).
 */
export function recordReplyLanded(ctx: MsgContext, now = Date.now()): void {
  const key = resolveReplyDedupeKey(ctx);
  const messageId = resolveInboundMessageId(ctx);
  if (!key || !messageId) {
    return;
  }
  const recordKey = `${key}|${messageId}`;
  const existing = replyLandedBySession.get(recordKey);
  replyLandedBySession.set(recordKey, {
    landedAt: Math.max(existing?.landedAt ?? 0, now),
  });
  prune(now);
}

/**
 * True when a reply already landed for this exact inbound message id in this
 * session, meaning the inbound is a stale re-presentation (channel ingress
 * re-dispatch of an errored turn) and should be suppressed rather than re-run.
 *
 * A genuinely NEW inbound carries a different message id and is never
 * suppressed, regardless of its (possibly older) provider timestamp. Returns
 * false when the inbound carries no usable message id (we cannot prove it is
 * a re-presentation) so that a turn is not accidentally suppressed.
 */
export function shouldSuppressReDispatch(ctx: MsgContext, now = Date.now()): boolean {
  const key = resolveReplyDedupeKey(ctx);
  const messageId = resolveInboundMessageId(ctx);
  if (!key || !messageId) {
    return false;
  }
  const record = replyLandedBySession.get(`${key}|${messageId}`);
  if (!record || record.landedAt < now - DEFAULT_REPLY_DEDUPE_TTL_MS) {
    return false;
  }
  if (shouldLogVerbose()) {
    logVerbose(
      `reply dedupe: suppressing re-dispatch for ${key} (messageId=${messageId} already has a landed reply at ${record.landedAt})`,
    );
  }
  return true;
}

/** Test-only: clear all reply-landed records. */
export function resetReplyDedupe(): void {
  replyLandedBySession.clear();
}
