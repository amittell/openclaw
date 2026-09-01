/** Durable-evidence rule for clearing a recovered auto-fallback primary probe. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { RuntimeFallbackAttempt } from "./agent-runner-execution.types.js";

type ModelSelection = { provider: string; model: string };

/**
 * A probe failure only justifies persisting an auto-fallback override when the
 * probe attempt carries a durable reason/error. Without that evidence the run
 * fell back for an unknown/transient cause, so the persisted probe must be
 * cleared instead of pinning the override to the fallback model.
 */
function hasDurableAutoFallbackPrimaryProbeFailureEvidence(params: {
  probe: ModelSelection;
  attempts: readonly RuntimeFallbackAttempt[];
}): boolean {
  const probeAttempt = params.attempts.find(
    (attempt) => attempt.provider === params.probe.provider && attempt.model === params.probe.model,
  );
  const reason = normalizeOptionalString(probeAttempt?.reason);
  if (reason) {
    return reason !== "unknown";
  }
  const error = normalizeOptionalString(probeAttempt?.error);
  return Boolean(error && error !== "unknown");
}

/**
 * Resolves which selection a recovered-probe clear should be addressed to.
 *
 * When the run settled on a model other than the probe, the persisted probe is
 * only worth keeping if the probe attempt itself failed for a durable reason.
 * Addressing the clear at the probe's own selection is what carries it past the
 * same-selection guard in `clearRecoveredAutoFallbackPrimaryProbeSelection`, so
 * a transient blip cannot pin the session override to the fallback model.
 *
 * NOTE: the caller's `attempts` are assigned from the fallback cycle's result,
 * so they are still empty on the first pass through the run loop -- the pass
 * that reconciles a settled candidate. The durable-evidence test therefore only
 * narrows this on later (post-compaction) iterations; on the first pass a
 * settled non-probe candidate always clears the pin.
 */
export function resolveAutoFallbackPrimaryProbeClearSelection(params: {
  activeProbe: ModelSelection | undefined;
  settled: ModelSelection;
  attempts: readonly RuntimeFallbackAttempt[];
}): ModelSelection {
  const activeProbe = params.activeProbe;
  if (!activeProbe) {
    return params.settled;
  }
  const settledOnProbe =
    params.settled.provider === activeProbe.provider && params.settled.model === activeProbe.model;
  if (settledOnProbe) {
    return params.settled;
  }
  return hasDurableAutoFallbackPrimaryProbeFailureEvidence({
    probe: activeProbe,
    attempts: params.attempts,
  })
    ? params.settled
    : { provider: activeProbe.provider, model: activeProbe.model };
}
