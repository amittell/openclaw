import { persistSessionTotalTokensAdvance } from "../../../auto-reply/reply/session-usage.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { shouldPreserveUserFacingSessionStateForInputProvenance } from "../../../sessions/input-provenance.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ContextTotalTokensAdvance = {
  /** Offers a settled model call's usage. Never awaits; safe on the event hot path. */
  offer: (usage: NormalizedUsage | undefined) => void;
  /** Stops accepting offers and waits until the latest accepted offer is written. */
  close: () => Promise<void>;
  /** Stops accepting offers, drops any pending one, and waits for the write in flight. */
  abandon: () => Promise<void>;
};

const DISABLED: ContextTotalTokensAdvance = {
  offer: () => {},
  close: async () => {},
  abandon: async () => {},
};

// Retries and fallbacks reuse the run's admitted context, so ownership of a
// published value spans the run's attempts and is released with the run.
const publishedByRun = new WeakMap<EmbeddedRunAttemptParams["admittedRunContext"], number>();

/**
 * Publishes the session's context total after each settled model call of an
 * attempt, before turn-completion accounting lands. One write is in flight at a
 * time and the latest offer wins, so a fast tool loop never queues store writes.
 * Every write is fenced on the session, lifecycle revision and writer claim the
 * run was admitted under. Compaction accounting lands at run settlement, after
 * every attempt has closed its writer; until then the run may lower only a value
 * it published itself.
 */
export function createContextTotalTokensAdvance(
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "admittedRunContext"
    | "runId"
    | "sessionId"
    | "sessionTarget"
    | "sessionPersistence"
    | "inputProvenance"
  >,
): ContextTotalTokensAdvance {
  const target = attempt.sessionTarget;
  if (
    attempt.sessionPersistence === "detached" ||
    !target?.storePath ||
    !target.sessionKey ||
    // Incognito stores have no worker path; keep their writes at turn completion.
    isIncognitoSessionKey(target.sessionKey) ||
    // Turn-completion accounting leaves these runs' context total untouched too.
    shouldPreserveUserFacingSessionStateForInputProvenance(attempt.inputProvenance)
  ) {
    return DISABLED;
  }
  const run = attempt.admittedRunContext;
  const scope = {
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: target.sessionKey,
    expectedSession: {
      sessionId: attempt.sessionId,
      lifecycleRevision: target.expectedLifecycleRevision,
      // A run that created its row is admitted before the row exists, so it has
      // no claim fact yet; the row it creates carries this run as its writer.
      activeWriterRunId: target.expectedWriterRunId ?? attempt.runId,
    },
  };
  let closed = false;
  let next: number | undefined;
  let inFlight: Promise<void> | undefined;

  const pump = () => {
    if (inFlight || next === undefined) {
      return;
    }
    const totalTokens = next;
    next = undefined;
    // The primitive logs and absorbs its own write failures.
    inFlight = persistSessionTotalTokensAdvance({
      ...scope,
      totalTokens,
      replaceOwnValue: publishedByRun.get(run),
    })
      .then((applied) => {
        if (applied) {
          publishedByRun.set(run, totalTokens);
        }
      })
      .finally(() => {
        inFlight = undefined;
        pump();
      });
  };

  const drain = async () => {
    // Each settled write re-pumps the latest pending offer before it resolves.
    while (inFlight) {
      await inFlight;
    }
  };

  return {
    offer: (usage) => {
      if (closed) {
        return;
      }
      // Prompt tokens only, as turn-completion accounting derives a call's total;
      // an explicitly unavailable context snapshot stays unknown.
      const totalTokens = deriveSessionTotalTokens({ lastCallUsage: usage });
      if (totalTokens === undefined) {
        return;
      }
      next = totalTokens;
      pump();
    },
    close: async () => {
      closed = true;
      await drain();
    },
    abandon: async () => {
      closed = true;
      next = undefined;
      await drain();
    },
  };
}
