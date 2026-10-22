// Grounds recent conversation rows before replay: same-turn tool-result media provenance,
// managed-media grounding of assistant text, and the channel replay byte budget.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractToolResultMediaArtifact,
  filterPersistedToolResultMediaUrls,
} from "../../agents/embedded-agent-tool-media.js";
import { MAX_GROUNDING_PATHS } from "../../media/media-grounding-limits.js";
import {
  findUnverifiedJoinedMediaSpellings,
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGroundingRoot,
} from "../../media/media-reference.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";
import type {
  SessionTranscriptBoundedMessageTailPage,
  SessionTranscriptMessageEvent,
  TranscriptEvent,
} from "./session-accessor.js";
import {
  invalidateUngroundedMediaPrefixes,
  type JoinedMediaSpellings,
} from "./transcript-grounding.js";

const MAX_RECENT_TRANSCRIPT_ENTRY_BYTES = 32 * 1024,
  MAX_RECENT_TRANSCRIPT_WINDOW_BYTES = 128 * 1024;

type ConversationEntry = { role: "user" | "assistant"; text: string };

/** A selected entry and the managed media its turn's trusted tool results carried. */
type RecentConversationRow<T extends ConversationEntry> = { entry: T; references: string[] };

function readTranscriptEventMessage(event: unknown): Record<string, unknown> | undefined {
  return isRecord(event) && event.type === "message" && isRecord(event.message)
    ? event.message
    : undefined;
}

function readTurnGroundedMediaPaths(
  message: Record<string, unknown>,
  maxResults: number,
): string[] {
  if (message.role !== "toolResult") {
    return [];
  }
  const rawToolName = typeof message.toolName === "string" ? message.toolName : undefined;
  // Stable transcripts through v2026.7.1-2 persisted the core image tool under
  // its former name. Normalize only this immutable history; live tools use view_image.
  const toolName = rawToolName === "image" ? "view_image" : rawToolName;
  return (
    extractToolResultMediaArtifact(message, {
      maxMediaCandidates: maxResults,
      maxMediaUrls: maxResults,
      acceptMediaUrl: (mediaUrl) =>
        filterPersistedToolResultMediaUrls(toolName, [mediaUrl], message).length > 0,
    })?.mediaUrls ?? []
  );
}

/** One tail page of visible messages, `offset` messages back from the newest. */
export type RecentConversationPageReader = (
  offset: number,
  maxMessages: number,
) => Promise<SessionTranscriptBoundedMessageTailPage>;

const RECENT_CONVERSATION_PAGE_SIZE = 250,
  MAX_PRECEDING_SAME_TURN_ROWS = 1_000,
  MAX_RECENT_CONVERSATION_READ_ATTEMPTS = 3;

type PageSnapshot = Pick<SessionTranscriptBoundedMessageTailPage, "snapshot" | "totalMessages">;

function isSameProjection(left: PageSnapshot, right: PageSnapshot): boolean {
  return (
    left.totalMessages === right.totalMessages &&
    left.snapshot.generation === right.snapshot.generation &&
    left.snapshot.boundarySeq === right.snapshot.boundarySeq &&
    left.snapshot.indexedSeq === right.snapshot.indexedSeq
  );
}

/**
 * One selection over consecutive tail pages; undefined when the projection moved between pages,
 * because offsets and same-turn provenance are only meaningful within one projection.
 */
async function selectFromOneProjection<T extends ConversationEntry>(
  readPage: RecentConversationPageReader,
  limit: number,
  select: (event: TranscriptEvent) => T | undefined,
): Promise<RecentConversationRow<T>[] | undefined> {
  const selected: Array<{ entry: T; preceding: SessionTranscriptMessageEvent[] }> = [];
  let pending: typeof selected = [];
  let first: PageSnapshot | undefined;
  for (let offset = 0; selected.length < limit || pending.length > 0;) {
    const page = await readPage(offset, RECENT_CONVERSATION_PAGE_SIZE);
    first ??= page;
    if (!isSameProjection(first, page)) {
      return undefined;
    }
    if (page.events.length === 0) {
      break;
    }
    offset += RECENT_CONVERSATION_PAGE_SIZE;
    for (const row of page.events.toReversed()) {
      if (selected.length >= limit && pending.length === 0) {
        break;
      }
      // SAFETY: Indexed rows retain message envelopes; losing one could cross turn provenance.
      const role = (row.event as { message?: { role?: unknown } })?.message?.role;
      if (role === "user") {
        pending = [];
      } else {
        for (const assistant of pending) {
          assistant.preceding.push(row);
        }
        pending = pending.filter(
          ({ preceding }) => preceding.length < MAX_PRECEDING_SAME_TURN_ROWS,
        );
      }
      const entry = selected.length < limit ? select(row.event) : undefined;
      if (entry) {
        const result: (typeof selected)[number] = { entry, preceding: [] };
        selected.push(result);
        if (entry.role === "assistant") {
          pending.push(result);
        }
      }
    }
  }
  return selected.map(({ entry, preceding }) => {
    const references: string[] = [];
    // Oldest first, as the turn wrote them, until the grounding budget is spent.
    for (const row of preceding.toReversed()) {
      if (references.length >= MAX_GROUNDING_PATHS) {
        break;
      }
      const message = readTranscriptEventMessage(row.event);
      if (message) {
        references.push(
          ...readTurnGroundedMediaPaths(message, MAX_GROUNDING_PATHS - references.length),
        );
      }
    }
    return { entry, references };
  });
}

/**
 * The newest `limit` entries `select` accepts, newest first, each assistant entry with the media
 * its own turn's tool results carried. Pages come from 10.5's tail reader (history worker, or the
 * captured incognito actor), and every page of one selection must come from the same projection.
 */
export async function selectRecentConversationRows<T extends ConversationEntry>(
  readPage: RecentConversationPageReader,
  limit: number,
  select: (event: TranscriptEvent) => T | undefined,
): Promise<RecentConversationRow<T>[]> {
  for (let attempt = 1; ; attempt += 1) {
    const rows = await selectFromOneProjection(readPage, limit, select);
    if (rows) {
      return rows;
    }
    if (attempt >= MAX_RECENT_CONVERSATION_READ_ATTEMPTS) {
      throw new Error("Recent conversation transcript changed during every read attempt");
    }
  }
}

/**
 * Oldest first, with unverified managed media removed from assistant text. `boundReplayBytes`
 * is channel replay's budget, applied after grounding: 32 KiB per entry and 128 KiB per read.
 */
export async function groundRecentConversationRows<T extends ConversationEntry>(
  rows: readonly RecentConversationRow<T>[],
  options: { limit: number; boundReplayBytes: boolean },
): Promise<T[]> {
  let groundingRoot: ManagedMediaGroundingRoot | undefined;
  const selected: T[] = [];
  let remainingBytes = MAX_RECENT_TRANSCRIPT_WINDOW_BYTES;
  for (const { entry, references } of rows) {
    if (options.boundReplayBytes && remainingBytes <= 0) {
      break;
    }
    if (entry.role === "assistant") {
      groundingRoot ??= await prepareManagedMediaGroundingRoot();
      const grounding = await prepareManagedMediaGrounding(groundingRoot, references);
      const joins: JoinedMediaSpellings = { found: new Set() };
      const grounded = invalidateUngroundedMediaPrefixes(entry.text, grounding, joins);
      // Only a recorded joined spelling needs the store, and only one it finds needs a rescan.
      const unverified = joins.found.size
        ? await findUnverifiedJoinedMediaSpellings(groundingRoot, grounding, joins.found)
        : undefined;
      entry.text = unverified?.size
        ? invalidateUngroundedMediaPrefixes(entry.text, grounding, { found: new Set(), unverified })
        : grounded;
    }
    let text = entry.text;
    if (options.boundReplayBytes) {
      text = truncateUtf8Prefix(text, Math.min(remainingBytes, MAX_RECENT_TRANSCRIPT_ENTRY_BYTES));
      remainingBytes -= Buffer.byteLength(text);
    }
    if (text) {
      selected.push({ ...entry, text });
      if (selected.length >= options.limit) {
        break;
      }
    }
  }
  return selected.toReversed();
}
