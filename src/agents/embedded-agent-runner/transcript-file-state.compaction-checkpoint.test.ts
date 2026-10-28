// Transcript file-state cases that remap compaction keep markers; the rebuilt
// context carries the checkpoint handle buildSessionContext appends to the summary.
import { afterEach, describe, expect, it } from "vitest";
import { expectedCompactionSummary } from "../test-helpers/compaction-checkpoint.js";
import {
  cleanupTranscriptFixtureRoots,
  readTranscriptState,
  writeTranscriptFixture,
} from "./transcript-file-state.test-support.js";

afterEach(async () => {
  await cleanupTranscriptFixtureRoots();
});

describe("readTranscriptState", () => {
  it("preserves legacy compaction keep indexes across JSON-valid non-object rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-v1-compaction-null-row-",
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "legacy prelude" },
        }),
        "null",
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "legacy kept suffix" },
        }),
        JSON.stringify({
          type: "compaction",
          timestamp: "2026-05-16T00:00:03.000Z",
          summary: "summary",
          firstKeptEntryIndex: 3,
          tokensBefore: 200,
        }),
      ],
      { version: 1 },
    );

    const state = await readTranscriptState(sessionFile);
    const kept = state
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "legacy kept suffix",
      );
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(kept).toBeDefined();
    expect(compaction).toMatchObject({ firstKeptEntryId: kept?.id });
    if (!compaction) {
      throw new Error("missing compaction fixture");
    }
    expect(state.buildSessionContext().messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: expectedCompactionSummary("summary", {
          entryId: compaction.id,
          shadowedEntryCount: 1,
        }),
      },
      { role: "user", content: "legacy kept suffix" },
    ]);
  });

  it("remaps compaction keep markers past malformed rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-compaction-marker-",
      [
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "before malformed row" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "after malformed row" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ],
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    if (!compaction) {
      throw new Error("missing compaction fixture");
    }
    expect(state.buildSessionContext().messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: expectedCompactionSummary("summary", {
          entryId: compaction.id,
          shadowedEntryCount: 0,
        }),
      },
      { role: "user", content: "before malformed row" },
      { role: "assistant", content: [{ type: "text", text: "after malformed row" }] },
    ]);
  });

  it("keeps valid suffixes when a compaction marker points at a malformed root", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-compaction-root-marker-",
      [
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "first valid kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ],
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    if (!compaction) {
      throw new Error("missing compaction fixture");
    }
    expect(state.buildSessionContext().messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: expectedCompactionSummary("summary", {
          entryId: compaction.id,
          shadowedEntryCount: 0,
        }),
      },
      { role: "user", content: "first valid kept turn" },
      { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
    ]);
  });

  it("remaps compaction keep markers through consecutive malformed rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-compaction-chain-marker-",
      [
        JSON.stringify({
          type: "message",
          id: "bad-root",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "bad-child",
          parentId: "bad-root",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "assistant" },
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "bad-child",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "first valid kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp: "2026-05-16T00:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "assistant-1",
          timestamp: "2026-05-16T00:00:05.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-root",
          tokensBefore: 200,
        }),
      ],
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "user-1" });
    if (!compaction) {
      throw new Error("missing compaction fixture");
    }
    expect(state.buildSessionContext().messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: expectedCompactionSummary("summary", {
          entryId: compaction.id,
          shadowedEntryCount: 0,
        }),
      },
      { role: "user", content: "first valid kept turn" },
      { role: "assistant", content: [{ type: "text", text: "valid reply" }] },
    ]);
  });

  it("remaps malformed compaction markers to descendants on the active branch", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-compaction-branch-marker-",
      [
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-a-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "other branch" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "active branch kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-assistant",
          parentId: "branch-b-user",
          timestamp: "2026-05-16T00:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "active reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "branch-b-assistant",
          timestamp: "2026-05-16T00:00:05.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ],
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "branch-b-user" });
    if (!compaction) {
      throw new Error("missing compaction fixture");
    }
    expect(state.buildSessionContext().messages).toMatchObject([
      {
        role: "compactionSummary",
        summary: expectedCompactionSummary("summary", {
          entryId: compaction.id,
          shadowedEntryCount: 0,
        }),
      },
      { role: "user", content: "active branch kept turn" },
      { role: "assistant", content: [{ type: "text", text: "active reply" }] },
    ]);
  });
});
