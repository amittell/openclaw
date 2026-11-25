import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveKeptPrefixStart } from "./session-accessor.sqlite-active-message-positions.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryProjection } from "./session-accessor.sqlite-history-projection.js";
import {
  readBoundaryEvents,
  readVisibleHistoryRange,
} from "./session-accessor.sqlite-history-query.js";
import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";

export type SessionTranscriptCompactionShadowPage = {
  displaySource?: string;
  /** `seq` is span-relative (1 = oldest shadowed row) so offset paging math is shared. */
  events: SessionTranscriptMessageEvent[];
  offset: number;
  shadowedCount: number;
};

/**
 * Reads the rows a compaction summary replaced: from the previous compaction's kept prefix
 * (or the visible window start) up to this boundary's kept prefix. The kept prefix is
 * excluded because it still replays verbatim after the summary; only the summarized span
 * is shadowed. Unknown ids and reset boundaries resolve to undefined.
 */
export function readSessionTranscriptCompactionShadowPage(
  scope: SessionTranscriptReadScope,
  options: { compactionId: string; maxMessages: number; offset: number },
): SessionTranscriptCompactionShadowPage | undefined {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const history = resolveVisibleHistoryProjection(projection);
    const index = history.boundaries.findIndex(
      (candidate) => candidate.eventId === options.compactionId,
    );
    const boundary = history.boundaries[index];
    if (!boundary) {
      return undefined;
    }
    const previous = history.boundaries[index - 1];
    const events = readBoundaryEvents(projection, previous ? [previous, boundary] : [boundary]);
    const event = asOptionalRecord(events.get(boundary.eventSeq));
    if (event?.type !== "compaction") {
      return undefined;
    }
    const previousEvent = previous ? asOptionalRecord(events.get(previous.eventSeq)) : undefined;
    const spanStart =
      previous && previousEvent?.type === "compaction"
        ? resolveKeptPrefixStart(projection, history, previous, previousEvent)
        : 0;
    const spanEnd = resolveKeptPrefixStart(projection, history, boundary, event);
    const shadowedCount = Math.max(0, spanEnd - spanStart);
    const offset = resolveIntegerOption(options.offset, 0, { min: 0, max: shadowedCount });
    const maxMessages = resolveIntegerOption(options.maxMessages, 0, { min: 0 });
    const endExclusive = spanEnd - offset;
    const start = Math.max(spanStart, endExclusive - maxMessages);
    const rows = readVisibleHistoryRange(projection, start, endExclusive, history);
    for (const entry of rows) {
      entry.seq -= spanStart;
    }
    return { displaySource: history.displaySource, events: rows, offset, shadowedCount };
  });
}
