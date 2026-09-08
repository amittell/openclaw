// Combine active-run views without making either lifecycle owner depend on its consumers.
import {
  getActiveReplyRunCount,
  listActiveReplyRunSessionKeys,
  listActiveReplyRunSessionIds,
  resolveActiveReplyRunSessionId,
  isReplyRunActiveForSessionId,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.registry.js";
import { replyRunState } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
} from "./run-state.js";

/** Task reconciliation must retain actual handles and reply cleanup owners, not UI progress alone. */
export function hasEmbeddedOrReplyRunForTask(params: {
  runIds: ReadonlySet<string>;
  sessionKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
}): boolean {
  if (
    [...params.runIds].some((runId) => ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.has(runId)) ||
    [...params.sessionKeys].some((key) => replyRunRegistry.isActive(key)) ||
    [...params.sessionIds].some(isReplyRunActiveForSessionId)
  ) {
    return true;
  }
  for (const barriers of [
    replyRunState.followupAdmissionBarriersByKey,
    replyRunState.successorAdmissionBarriersByKey,
  ]) {
    for (const [sessionKey, barrier] of barriers) {
      if (params.sessionKeys.has(sessionKey) || params.sessionIds.has(barrier.sessionId)) {
        return true;
      }
    }
  }
  if (
    [...params.sessionIds].some((id) => ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.has(id)) ||
    [...params.sessionKeys].some((key) => ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(key))
  ) {
    return true;
  }
  for (const [sessionId, handle] of ACTIVE_EMBEDDED_RUNS) {
    const registration = ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle);
    if (
      params.sessionIds.has(sessionId) ||
      (handle.runId !== undefined && params.runIds.has(handle.runId)) ||
      (registration?.sessionKey !== undefined && params.sessionKeys.has(registration.sessionKey))
    ) {
      return true;
    }
  }
  return [...params.sessionKeys].some((key) => ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.has(key));
}

/** Counts active embedded runs while including auto-reply registry runs for shared sessions. */
export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

/** Lists active embedded-run session keys from both embedded and auto-reply registries. */
export function listActiveEmbeddedRunSessionKeys(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(),
      ...listActiveReplyRunSessionKeys(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Lists active embedded-run session ids from all embedded-run lookup maps. */
export function listActiveEmbeddedRunSessionIds(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUNS.keys(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.values(),
      ...listActiveReplyRunSessionIds(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Resolves the current session id for an active run after resets or compaction. */
export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return (
    resolveActiveReplyRunSessionId(normalizedSessionKey) ??
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
  );
}
