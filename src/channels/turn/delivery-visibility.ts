/** Visibility predicates for channel-turn delivery outcomes.
 *
 * Split out of ./lifecycle.ts to keep that file within the max-lines budget.
 * These are pure `unknown`-in predicates over the structural `visibleReplySent`
 * marker that delivery adapters stamp onto results and errors.
 */

import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { toCoreManagedDeliveryInfo } from "./direct-delivery-custody.js";
import type { ChannelEventDeliveryAdapter, ChannelTurnDeliveryAdapter } from "./types.js";

export type AnyChannelDeliveryAdapter = ChannelEventDeliveryAdapter | ChannelTurnDeliveryAdapter;

export const CHANNEL_TURN_DISPATCH_FALLBACK_TEXT =
  "I hit a problem handling that message. Please try again, or use /new.";

/** Sends the visible non-outcome fallback through the adapter's direct deliverer. */
export async function deliverChannelTurnDispatchFallback(
  delivery: AnyChannelDeliveryAdapter,
  payload: ReplyPayload,
): Promise<void> {
  // AnyChannelDeliveryAdapter is a union: the provider-owned variant declares
  // `deliver?: never`. Same guard the routed direct branch uses.
  if (!("deliver" in delivery) || !delivery.deliver) {
    throw new Error("channel delivery adapter is missing a direct deliverer");
  }
  await delivery.deliver(payload, toCoreManagedDeliveryInfo({ kind: "final" }));
}

/** True when a delivery result explicitly reports that nothing was shown to the user. */
export function isExplicitlyNonVisibleChannelDelivery(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    // SAFETY: guarded above by typeof "object", non-null and not-an-array.
    (result as { visibleReplySent?: unknown }).visibleReplySent === false
  );
}

// A failure whose own error carries the durable partial-send / visible-send
// marker (markDurableInboundReplyDeliveryErrorVisible,
// markChannelDeliveryErrorVisible) already put something in front of the user;
// the fallback must never double-send over it.
export function failureAlreadyDeliveredVisible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    // SAFETY: the typeof "object" and non-null guards above make this optional-property probe total.
    (error as { visibleReplySent?: unknown }).visibleReplySent === true
  );
}

/** Stamps an error as having already reached the user, wrapping it when frozen. */
export function markChannelDeliveryErrorVisible(error: unknown): unknown {
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    try {
      Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
      return error;
    } catch {
      // Fall back to a wrapper when a platform error object is non-extensible.
    }
  }
  const visibleError = new Error("visible channel reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}
