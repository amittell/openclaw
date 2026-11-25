// The fork's grounded recent-conversation read for SQLite transcripts: transcript.ts uses it in
// place of 11.10's recent-text worker read.
import type { SessionTranscriptReadScope } from "./session-accessor.js";
import {
  groundRecentConversationRows,
  selectRecentConversationRows,
} from "./transcript-recent-grounding.js";
import {
  extractRecentConversationText,
  type ReadRecentSessionConversationTurnOptions,
  type SessionRecentConversationTurn,
} from "./transcript-recent-text.js";

/**
 * transcript.ts's recent user/assistant turns for one SQLite transcript: the selection 11.10's
 * recent-text worker read makes, grounded by transcript-recent-grounding.ts, and byte-bounded
 * for channel replay.
 */
export async function readRecentGroundedConversationTurns(
  scope: SessionTranscriptReadScope,
  assertCurrent: () => void,
  options: ReadRecentSessionConversationTurnOptions,
): Promise<SessionRecentConversationTurn[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? 10));
  // 11.10's deliveryOnly (#183190) filters after the window is chosen, as readRecentTranscriptConversationText does.
  const deliveredEntries = new WeakSet<object>();
  const { readSessionTranscriptBoundedMessageTailPageAsync } =
    await import("../../gateway/session-transcript-readers.js");
  const { readRestoredSessionTranscript } = await import("./session-cold-storage-read.js");
  // Pages go through 10.5's reader (history worker, or the captured incognito actor); a
  // cold-storage restore retries the selection, and grounding runs after it on the rows plus
  // the same-turn provenance gathered with them.
  const rows = await readRestoredSessionTranscript(
    scope,
    () =>
      selectRecentConversationRows(
        (offset, maxMessages) =>
          readSessionTranscriptBoundedMessageTailPageAsync(scope, {
            maxMessages,
            // Preserve the existing message-count-only bound for this text projection.
            maxBytes: Number.MAX_SAFE_INTEGER,
            offset,
          }),
        limit,
        (event) => {
          // The same window readRecentTranscriptConversationText applies (#183749 inlined it).
          const extracted = extractRecentConversationText(event, options);
          const entry = extracted?.entry;
          if (extracted?.deliveryOnly) {
            deliveredEntries.add(extracted.entry);
          }
          return entry &&
            (options.beforeTimestampMs === undefined ||
              entry.timestamp === undefined ||
              entry.timestamp < options.beforeTimestampMs) &&
            (options.minTimestampMs === undefined ||
              entry.timestamp === undefined ||
              entry.timestamp >= options.minTimestampMs)
            ? entry
            : undefined;
        },
      ),
    { assertCurrent },
  );
  return await groundRecentConversationRows(
    options.deliveryOnly ? rows.filter(({ entry }) => deliveredEntries.has(entry)) : rows,
    {
      limit,
      boundReplayBytes: options.boundReplayBytes === true,
    },
  );
}
