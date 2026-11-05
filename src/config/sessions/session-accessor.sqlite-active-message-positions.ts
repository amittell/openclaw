import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  resolveHistoryMessageSequence,
  type VisibleHistoryBoundary,
  type VisibleHistoryProjection,
} from "./session-accessor.sqlite-history-projection.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { resolveVisibleMessagePositions } from "./session-accessor.sqlite-reset-window.js";

/** Active message rows in this snapshot: a raw seq range, or the first at or after an entry. */
export function readActiveMessagePositionRows(
  projection: CurrentTranscriptProjection,
  selection: { firstSeq: number; lastSeq: number } | { atOrAfterEntryId: string },
) {
  const sessionId = projection.resolved.sessionId;
  const query = getActiveTranscriptKysely(projection.database)
    .selectFrom("session_transcript_active_events")
    .select(["event_seq", "message_position"])
    .where("session_id", "=", sessionId);
  return executeSqliteQuerySync(
    projection.database.db,
    "atOrAfterEntryId" in selection
      ? query
          .where("message_position", "is not", null)
          .where("active_position", ">=", (eb) =>
            eb
              .selectFrom("transcript_event_identities as identity")
              .innerJoin("session_transcript_active_events as anchor", (join) =>
                join
                  .onRef("anchor.session_id", "=", "identity.session_id")
                  .onRef("anchor.event_seq", "=", "identity.seq"),
              )
              .select("anchor.active_position")
              .where("identity.session_id", "=", sessionId)
              .where("identity.event_id", "=", selection.atOrAfterEntryId),
          )
          .orderBy("active_position", "asc")
          .limit(1)
      : query
          .where("event_seq", ">=", selection.firstSeq)
          .where("event_seq", "<=", selection.lastSeq)
          .where("message_position", "is not", null),
  ).rows;
}

/** Display position of the first visible row at or after an entry; undefined when off-branch. */
function resolveDisplayPositionAtOrAfter(
  projection: CurrentTranscriptProjection,
  history: VisibleHistoryProjection,
  entryId: string,
): number | undefined {
  const row = readActiveMessagePositionRows(projection, { atOrAfterEntryId: entryId })[0];
  if (!row || row.message_position === null) {
    return undefined;
  }
  const seq = resolveHistoryMessageSequence(
    resolveVisibleMessagePositions(projection),
    history,
    row.message_position,
  );
  return seq === undefined ? undefined : seq - 1;
}

/** Where a boundary's kept prefix starts; the boundary itself when nothing before it was kept. */
export function resolveKeptPrefixStart(
  projection: CurrentTranscriptProjection,
  history: VisibleHistoryProjection,
  boundary: VisibleHistoryBoundary,
  event: Record<string, unknown>,
): number {
  const firstKeptEntryId = event.firstKeptEntryId;
  const keptStart =
    typeof firstKeptEntryId === "string"
      ? resolveDisplayPositionAtOrAfter(projection, history, firstKeptEntryId)
      : undefined;
  return keptStart !== undefined && keptStart < boundary.displayPosition
    ? keptStart
    : boundary.displayPosition;
}
