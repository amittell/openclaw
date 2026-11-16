/** Settlement of the private sources behind one collected pending input.
 *
 * Split out of ./session-accessor.pending-inputs.ts to keep that module within the
 * max-lines budget.
 */
import type { SessionPendingInputOwner } from "./session-pending-input-owner.types.js";

/** Finishes every collected source, then reports all of their failures together. */
export function finishPendingInputSources(
  sources: readonly SessionPendingInputOwner[],
  disposition: "cancelled" | "interrupted",
): void {
  const failures: unknown[] = [];
  for (const source of sources) {
    try {
      source.finish(disposition);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "Failed to finish collected input custody");
  }
}
