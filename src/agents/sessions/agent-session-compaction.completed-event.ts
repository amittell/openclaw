/** The `compaction_end` event a completed compaction publishes.
 *
 * Split out of ./agent-session-compaction.ts to keep that module within the
 * max-lines budget.
 */
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import type { CompactionResult } from "../runtime/index.js";
import type { AgentSessionEvent } from "./agent-session-types.js";

type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

/** Builds the completed `compaction_end` event, carrying the summary's quality-degraded flag. */
export function buildCompletedCompactionEndEvent(
  reason: CompactionEndEvent["reason"],
  itemId: string,
  outcome: { result: CompactionResult; tokensAfter: number },
  willRetry: boolean,
): CompactionEndEvent {
  return {
    type: "compaction_end",
    reason,
    itemId,
    outcome: {
      status: "completed",
      tokensBefore: outcome.result.tokensBefore,
      tokensAfter: outcome.tokensAfter,
      willRetry,
      ...(parseCompactionDetails(outcome.result.details)?.qualityDegraded
        ? { qualityDegraded: true }
        : {}),
    },
  };
}
