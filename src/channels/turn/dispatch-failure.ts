/** Dispatch-failure outcomes for channel turns.
 *
 * Split out of ./lifecycle.ts to keep that file within the max-lines budget.
 * Owns the `durableTerminal` marker: a failed durable send is tagged with it, and
 * the visible non-outcome fallback reads it so a settled failure is not re-sent.
 */

import type { DispatchFromConfigResult } from "../../auto-reply/reply/dispatch-from-config.types.js";
import { toErrorObject } from "../../infra/errors.js";
import { recordAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import { failureAlreadyDeliveredVisible } from "./delivery-visibility.js";
import { hasVisibleChannelTurnDispatch } from "./dispatch-result.js";
import type { ChannelTurnDispatchResultLike } from "./dispatch-result.js";
import { throwIfDurableInboundReplyDeliveryFailed } from "./durable-delivery.js";
import type { AssembledChannelTurn } from "./types.js";

/** Rethrows a failed durable send, tagged as a terminal preflight failure. */
export function throwIfTerminalDurableDeliveryFailed(
  durable: Parameters<typeof throwIfDurableInboundReplyDeliveryFailed>[0],
): void {
  try {
    throwIfDurableInboundReplyDeliveryFailed(durable);
  } catch (err: unknown) {
    // Tag terminal preflight failures so the Bug 2 fallback
    // (visible non-outcome) does not double-send after them.
    if (typeof err === "object" && err !== null && Object.isExtensible(err)) {
      // SAFETY: guarded above by typeof "object", non-null and Object.isExtensible, so tagging is allowed.
      (err as { durableTerminal?: unknown }).durableTerminal = true;
    }
    throw err;
  }
}

/**
 * Visible non-outcome (Bug 2): a user-visible turn whose dispatch failed
 * with NOTHING visible already settled must still end in a visible
 * outcome, so the caller delivers the fallback before rethrowing. Opt out
 * when a durable partial send already delivered (visibleReplySent marker), a
 * terminal durable preflight failure settled the send (durableTerminal),
 * a payload was already queued, or the turn is observeOnly/system.
 */
export function shouldDeliverDispatchFailureFallback(
  turn: Pick<AssembledChannelTurn, "admission" | "ctxPayload">,
  outcome: {
    dispatchError: unknown;
    dispatchResult: DispatchFromConfigResult | undefined;
    settlementError: unknown;
  },
): boolean {
  const durableTerminal =
    // SAFETY: optional probe on an unknown error; ?. covers null/undefined and a miss yields undefined.
    (outcome.dispatchError as { durableTerminal?: unknown })?.durableTerminal === true;
  if (
    turn.admission?.kind !== "observeOnly" &&
    turn.ctxPayload.InternalTurnSource === undefined &&
    outcome.dispatchError !== undefined &&
    outcome.settlementError === undefined &&
    !durableTerminal &&
    !failureAlreadyDeliveredVisible(outcome.dispatchError)
  ) {
    // Nothing visible settled: no result, or a result without a visible delivery.
    return (
      !outcome.dispatchResult ||
      // SAFETY: hasVisibleChannelTurnDispatch reads only optional structural fields; !dispatchResult excluded above.
      !hasVisibleChannelTurnDispatch(outcome.dispatchResult as ChannelTurnDispatchResultLike)
    );
  }
  return false;
}

/**
 * Records a terminal failure so the ingress drain dead-letter path sees a
 * recorded outcome instead of a silent non-outcome (blocker 3): the visible
 * fallback already put an explanation in front of the user. Error values keep
 * their identity; a string becomes the message and any other value the cause.
 */
export function toSurfacedDispatchError(dispatchError: unknown): Error {
  const surfacedError = toErrorObject(dispatchError, "channel dispatch failed");
  if (Object.isExtensible(surfacedError)) {
    recordAgentRunTerminalOutcome(surfacedError, "failed");
  }
  return surfacedError;
}
