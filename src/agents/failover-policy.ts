/**
 * Shared failover policy helpers for auth profile cooldown probing.
 */
import type { FailoverReason } from "./embedded-agent-helpers.js";

/** Returns true when a failed model can be probed during cooldown. */
export function shouldAllowCooldownProbeForReason(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "billing" ||
    // Untyped 5xx is probe-eligible for the same reason the other transient
    // reasons are. Upstream main derives this list from
    // shouldUseTransientCooldownProbeSlot, so #141843 only had to add it there;
    // on this release base the two lists are independent and both need it.
    reason === "server_error" ||
    reason === "unknown" ||
    reason === "empty_response" ||
    reason === "no_error_details" ||
    reason === "unclassified" ||
    reason === "timeout"
  );
}

/** Returns true when a transient failure should consume a cooldown probe slot. */
export function shouldUseTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "rate_limit" ||
    reason === "overloaded" ||
    reason === "unknown" ||
    reason === "empty_response" ||
    reason === "no_error_details" ||
    reason === "unclassified" ||
    reason === "server_error" ||
    reason === "timeout"
  );
}

/** Returns true when a non-transient failure should leave transient probe budget intact. */
export function shouldPreserveTransientCooldownProbeSlot(
  reason: FailoverReason | null | undefined,
): boolean {
  return (
    reason === "model_not_found" ||
    reason === "format" ||
    reason === "auth" ||
    reason === "auth_permanent" ||
    reason === "session_expired" ||
    reason === "tls_certificate"
  );
}
