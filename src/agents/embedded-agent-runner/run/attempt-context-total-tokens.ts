/**
 * Publishes the session entry's context snapshot after each model call of a
 * long attempt, so status readers see a growing count before turn-completion
 * accounting lands.
 */
import { persistSessionTotalTokensAdvance } from "../../../auto-reply/reply/session-usage.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../usage.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type ContextTotalTokensAdvance = {
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

/**
 * Creates the per-attempt writer. One write is in flight at a time and the
 * latest offer wins, so a fast tool loop never queues store writes behind the
 * model. Every write is fenced on the generation the attempt was admitted
 * under. Compaction accounting belongs to the host loop and lands at run
 * settlement, after the attempt has closed this writer.
 */
export function createContextTotalTokensAdvance(params: {
  attempt: Pick<EmbeddedRunAttemptParams, "sessionId" | "sessionTarget" | "sessionPersistence">;
}): ContextTotalTokensAdvance {
  const { attempt } = params;
  const target = attempt.sessionTarget;
  if (attempt.sessionPersistence === "detached" || !target?.storePath || !target.sessionKey) {
    return DISABLED;
  }
  const scope = {
    agentId: target.agentId,
    storePath: target.storePath,
    sessionKey: target.sessionKey,
  };
  const expectedSession = {
    sessionId: attempt.sessionId,
    ...(target.expectedLifecycleRevision !== undefined
      ? { lifecycleRevision: target.expectedLifecycleRevision }
      : {}),
    ...(target.expectedWriterRunId !== undefined
      ? { activeWriterRunId: target.expectedWriterRunId }
      : {}),
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
    // The primitive logs and swallows its own write failures.
    inFlight = persistSessionTotalTokensAdvance({ ...scope, totalTokens, expectedSession }).finally(
      () => {
        inFlight = undefined;
        pump();
      },
    );
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
      // Same derivation as turn-completion accounting: prompt tokens only, and
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
