import { describe, expect, it, vi } from "vitest";
import type {
  SessionTranscriptBoundedMessageTailPage,
  TranscriptEvent,
} from "./session-accessor.js";
import {
  selectRecentConversationRows,
  type RecentConversationPageReader,
} from "./transcript-recent-grounding.js";

type Entry = { role: "user" | "assistant"; text: string };

const transcript = Array.from({ length: 300 }, (_, index) => ({
  type: "message",
  id: `m-${index}`,
  message: { role: index % 2 ? "assistant" : "user", content: `message ${index}` },
}));

function select(event: TranscriptEvent): Entry | undefined {
  // SAFETY: The fixture holds only message events with string content.
  const message = (event as (typeof transcript)[number]).message;
  return message.role === "user" || message.role === "assistant"
    ? { role: message.role, text: message.content }
    : undefined;
}

/** Tail pages of `transcript`; `indexedSeq` reports which committed projection served each page. */
function pageReader(indexedSeq: () => number): RecentConversationPageReader {
  return async (offset, maxMessages) => {
    const end = Math.max(0, transcript.length - offset);
    const start = Math.max(0, end - maxMessages);
    const events = transcript
      .slice(start, end)
      .map((event, index) => ({ event, eventSeq: start + index, seq: start + index }));
    return {
      activeLeafEntryId: transcript.at(-1)!.id,
      events,
      newestContiguousEventCount: events.length,
      scannedMessages: events.length,
      serializedBytes: 0,
      snapshot: { generation: "g", indexedSeq: indexedSeq() },
      totalMessages: transcript.length,
    } satisfies SessionTranscriptBoundedMessageTailPage;
  };
}

describe("selectRecentConversationRows", () => {
  it("restarts a selection whose projection moved between its pages", async () => {
    let reads = 0;
    // The first attempt's second page comes from a later commit; the retry reads one projection.
    const read = vi.fn(pageReader(() => (++reads === 2 ? 2 : 1)));

    const rows = await selectRecentConversationRows(read, 300, select);

    expect(rows).toHaveLength(300);
    expect(rows[0]?.entry.text).toBe("message 299");
    expect(rows.at(-1)?.entry.text).toBe("message 0");
    expect(read.mock.calls.map(([offset]) => offset)).toEqual([0, 250, 0, 250]);
  });

  it("refuses a selection whose projection moves on every attempt", async () => {
    let reads = 0;
    const read = vi.fn(pageReader(() => ++reads));

    await expect(selectRecentConversationRows(read, 300, select)).rejects.toThrow(
      "Recent conversation transcript changed during every read attempt",
    );
    expect(read).toHaveBeenCalledTimes(6);
  });

  it("reads one page when the newest page satisfies the limit", async () => {
    const read = vi.fn(pageReader(() => 1));

    const rows = await selectRecentConversationRows(read, 2, select);

    expect(rows.map(({ entry }) => entry)).toEqual([
      { role: "assistant", text: "message 299" },
      { role: "user", text: "message 298" },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
