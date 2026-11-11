import { describe, expect, it } from "vitest";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readSessionTranscriptCompactionShadowPage } from "./session-accessor.sqlite-history-events.js";
import {
  historyEventId,
  readSessionTranscriptHistoryEvents,
  useHistoryEventScope,
} from "./session-accessor.sqlite-history.test-support.js";

describe("SQLite transcript compaction shadow pages", () => {
  const scope = useHistoryEventScope();

  it("resolves the span each of two successive compactions shadows", async () => {
    // m1 m2 [m3 m4] c1(keeps m3) m5 m6 [m7] c2(keeps m7) m8
    const turn = (eventId: string, parentId: string | null, content: string) => ({
      eventId,
      parentId,
      message: { role: Number(eventId.slice(1)) % 2 === 0 ? "assistant" : "user", content },
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [turn("m1", null, "one"), turn("m2", "m1", "two")],
      touchSessionEntry: false,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [turn("m3", "m2", "three"), turn("m4", "m3", "four")],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "c1",
      parentId: "m4",
      timestamp: "2026-08-15T00:00:01.000Z",
      summary: "first",
      firstKeptEntryId: "m3",
      tokensBefore: 10,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [turn("m5", "c1", "five"), turn("m6", "m5", "six"), turn("m7", "m6", "seven")],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "c2",
      parentId: "m7",
      timestamp: "2026-08-15T00:00:02.000Z",
      summary: "second",
      firstKeptEntryId: "m7",
      tokensBefore: 20,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [turn("m8", "c2", "eight")],
      touchSessionEntry: false,
    });
    const ids = (events: Array<{ event: unknown }> | undefined) => events?.map(historyEventId);
    expect(ids(readSessionTranscriptHistoryEvents(scope))).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "c1",
      "m5",
      "m6",
      "m7",
      "c2",
      "m8",
    ]);

    const first = readSessionTranscriptCompactionShadowPage(scope, {
      compactionId: "c1",
      maxMessages: 10,
      offset: 0,
    });
    const second = readSessionTranscriptCompactionShadowPage(scope, {
      compactionId: "c2",
      maxMessages: 10,
      offset: 0,
    });

    // Each span stops at its own kept prefix; the later span starts where the earlier
    // compaction's kept rows re-entered context, so the two never overlap.
    expect(first).toMatchObject({ offset: 0, shadowedCount: 2 });
    expect(ids(first?.events)).toEqual(["m1", "m2"]);
    expect(second).toMatchObject({ offset: 0, shadowedCount: 5 });
    expect(ids(second?.events)).toEqual(["m3", "m4", "c1", "m5", "m6"]);
    expect(second?.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);

    const newest = readSessionTranscriptCompactionShadowPage(scope, {
      compactionId: "c2",
      maxMessages: 2,
      offset: 0,
    });
    const older = readSessionTranscriptCompactionShadowPage(scope, {
      compactionId: "c2",
      maxMessages: 2,
      offset: 2,
    });
    const oldest = readSessionTranscriptCompactionShadowPage(scope, {
      compactionId: "c2",
      maxMessages: 2,
      offset: 4,
    });
    expect(ids(newest?.events)).toEqual(["m5", "m6"]);
    expect(ids(older?.events)).toEqual(["m4", "c1"]);
    expect(oldest).toMatchObject({ offset: 4, shadowedCount: 5 });
    expect(ids(oldest?.events)).toEqual(["m3"]);

    for (const compactionId of ["m5", "missing"]) {
      expect(
        readSessionTranscriptCompactionShadowPage(scope, {
          compactionId,
          maxMessages: 10,
          offset: 0,
        }),
      ).toBeUndefined();
    }
  });
});
