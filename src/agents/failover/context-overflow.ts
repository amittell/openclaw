import { matchesContextOverflowMessage } from "@openclaw/ai/internal/runtime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  hasRateLimitTpmHint,
  isContextOverflowErrorFromTables,
  isReasoningConstraintErrorMessage,
  looksLikeProviderContextOverflowCandidate,
} from "./context-overflow-tables.js";
import {
  isBillingErrorMessage,
  isProviderRequestSizeCeilingError,
  isRateLimitErrorMessage,
} from "./message-patterns.js";
import {
  classifyProviderPluginError,
  type PreparedProviderFailoverOwner,
} from "./provider-patterns.js";

/**
 * Detects Anthropic's 429 "Extra usage is required for long context requests." error.
 *
 * Anthropic returns HTTP 429 for this case, but it is semantically a context overflow
 * (the session is too large for the standard usage tier), not a transient rate limit.
 * It should be routed to the compact+retry path instead of the model fallback chain.
 * Kept internal to the failover module (carried from openclaw PR #111913).
 */
function isAnthropicLongContextUsageError(errorMessage: string): boolean {
  return normalizeLowercaseStringOrEmpty(errorMessage).includes(
    "extra usage is required for long context",
  );
}

export function isContextOverflowError(
  errorMessage?: string,
  opts?: { providerPlugin?: PreparedProviderFailoverOwner | null },
): boolean {
  if (!errorMessage) {
    return false;
  }
  return (
    isContextOverflowErrorFromTables(errorMessage) ||
    (looksLikeProviderContextOverflowCandidate(errorMessage) &&
      classifyProviderPluginError({ errorMessage, providerPlugin: opts?.providerPlugin }) ===
        "context_overflow")
  );
}

export function isLikelyContextOverflowError(errorMessage?: string): boolean {
  if (!errorMessage) {
    return false;
  }

  // Settle an unsatisfiable request size first: the TPM and rate-limit exclusions below would
  // otherwise claim the message on its rate-limit wording alone.
  if (isProviderRequestSizeCeilingError(errorMessage)) {
    return isContextOverflowErrorFromTables(errorMessage);
  }

  // Quota, billing, and reasoning failures can contain the same broad token-limit
  // wording; exclude them before consulting the overflow heuristic or provider.
  if (hasRateLimitTpmHint(errorMessage) || isReasoningConstraintErrorMessage(errorMessage)) {
    return false;
  }
  // This Anthropic 429 is constrained by context size, so compact and retry
  // before the broader billing and rate-limit classifiers can claim it.
  if (isAnthropicLongContextUsageError(errorMessage)) {
    return true;
  }
  if (
    isBillingErrorMessage(errorMessage) ||
    matchesContextOverflowMessage(errorMessage, "context-window-too-small") ||
    isRateLimitErrorMessage(errorMessage)
  ) {
    return false;
  }
  if (isContextOverflowError(errorMessage)) {
    return true;
  }
  return (
    !normalizeLowercaseStringOrEmpty(errorMessage).includes("prompt template") &&
    !matchesContextOverflowMessage(errorMessage, "rate-limit-hint") &&
    matchesContextOverflowMessage(errorMessage, "failover-hint")
  );
}
