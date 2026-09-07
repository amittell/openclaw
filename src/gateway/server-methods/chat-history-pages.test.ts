import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  enrichChatHistoryCompactionMarkers,
  readChatHistoryWindowPage,
} from "./chat-history-pages.js";

describe("enrichChatHistoryCompactionMarkers", () => {
  it("joins checkpoint token metrics to the matching transcript marker", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1", seq: 4 },
    };
    const entry = {
      compactionCheckpoints: [
        {
          checkpointId: "checkpoint-1",
          sessionKey: "main",
          sessionId: "session-1",
          createdAt: 1_000,
          reason: "auto-threshold",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
          preCompaction: { sessionId: "session-1" },
          postCompaction: { sessionId: "session-1", entryId: "compact-entry-1" },
        },
      ],
    } as SessionEntry;

    const result = enrichChatHistoryCompactionMarkers([marker], entry);

    expect(result[0]).toEqual({
      ...marker,
      __openclaw: {
        ...marker["__openclaw"],
        tokensBefore: 900_000,
        tokensAfter: 24_700,
      },
    });
    expect(marker["__openclaw"]).not.toHaveProperty("tokensBefore");
  });

  it("preserves message identity without a matching checkpoint", () => {
    const marker = {
      role: "system",
      __openclaw: { kind: "compaction", id: "compact-entry-1" },
    };

    const result = enrichChatHistoryCompactionMarkers([marker], undefined);

    expect(result[0]).toBe(marker);
  });
});

const readers = vi.hoisted(() => ({
  tail: vi.fn(),
  around: vi.fn(),
  span: vi.fn(),
  full: vi.fn(),
  imported: vi.fn(),
}));

vi.mock("../session-history-tail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-history-tail.js")>()),
  readIncrementalChatHistoryTail: readers.tail,
}));
vi.mock("../session-transcript-anchor-reader.js", () => ({
  readSessionMessagesAroundIdWithStatsAsync: readers.around,
}));
vi.mock("../session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-transcript-readers.js")>()),
  readSessionMessagesAsync: readers.full,
  readSessionMessagesShadowedByCompactionAsync: readers.span,
}));
vi.mock("../cli-session-history.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli-session-history.js")>()),
  readChatHistoryCliSessionImportSnapshot: readers.imported,
}));

describe("readChatHistoryWindowPage anchor routing", () => {
  const message = (text: string, timestamp: number) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  });
  const local = message("live local tail", 2);
  const shadowed = message("shadowed before compaction", 1);
  const anchored = {
    ...message("anchored history", 1),
    __openclaw: { id: "entry-message-1" },
  };
  const imported = message("external CLI history", 3);
  const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
  const params = {
    entry,
    provider: "anthropic",
    sessionId: "session-1",
    storePath: "/history-fixture/sessions.json",
    sessionAgentId: "main",
    canonicalKey: "agent:main:history",
    max: 10,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 10_000,
    offset: undefined,
    messageId: undefined,
  };
  const cliEntry: SessionEntry = { ...entry, claudeCliSessionId: "claude-cli-session-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    readers.tail.mockResolvedValue({
      readPage: {
        messages: [local],
        totalMessages: 1,
        transcriptSource: "active",
        activeLeafEntryId: "local-leaf",
        deltaCursor: "local-cursor",
      },
      rawMessages: [local],
      projected: [local],
      rawPageMessages: 1,
    });
    readers.around.mockResolvedValue({
      found: true,
      hasOverreadContext: false,
      offset: 4,
      messages: [anchored],
      totalMessages: 5,
    });
    readers.span.mockResolvedValue({ messages: [shadowed], totalMessages: 3, offset: 1 });
    readers.full.mockResolvedValue([local]);
    readers.imported.mockResolvedValue([imported]);
  });

  it("returns the shadowed compaction span even with a CLI import binding", async () => {
    // The original regression returned the live tail/CLI merge for this request.
    const page = await readChatHistoryWindowPage({
      ...params,
      entry: cliEntry,
      compactionId: "entry-compaction-1",
      offset: 1,
    });
    expect(page).toMatchObject({
      messages: [shadowed],
      responseOffset: 1,
      pagination: { offset: 1, totalMessages: 3, rawPageMessages: 1 },
    });
    expect(page).not.toHaveProperty("completeCliImport");
    expect(readers.span).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: params.canonicalKey }),
      { compactionId: "entry-compaction-1", maxMessages: 10, offset: 1 },
    );
    expect(readers.tail).not.toHaveBeenCalled();
    expect(readers.imported).not.toHaveBeenCalled();
  });

  it.each([{ offset: 0 }, { messageId: "entry-message-1" }])(
    "merges CLI history for bound offset/message anchors %j",
    async (anchor) => {
      const page = await readChatHistoryWindowPage({ ...params, ...anchor, entry: cliEntry });
      expect(page).toMatchObject({
        messages: [local, imported],
        completeCliImport: true,
        pagination: { offset: 0, totalMessages: 2, rawPageMessages: 2, exhausted: true },
      });
      expect(readers.around).not.toHaveBeenCalled();
      expect(readers.span).not.toHaveBeenCalled();
      expect(readers.full).toHaveBeenCalledOnce();
    },
  );

  it("reads an offset window directly without a CLI binding", async () => {
    const page = await readChatHistoryWindowPage({ ...params, offset: 2 });
    expect(page).toMatchObject({ messages: [local], responseOffset: 2 });
    expect(readers.tail).toHaveBeenCalledWith(expect.objectContaining({ offset: 2 }));
    expect(readers.imported).not.toHaveBeenCalled();
  });

  it("reads a message anchor directly without a CLI binding", async () => {
    const page = await readChatHistoryWindowPage({ ...params, messageId: "entry-message-1" });
    expect(page).toMatchObject({ messages: [anchored] });
    expect(page).not.toHaveProperty("pagination");
    expect(readers.around).toHaveBeenCalledOnce();
    expect(readers.tail).not.toHaveBeenCalled();
  });

  it("reads a compaction span directly without a CLI binding", async () => {
    const page = await readChatHistoryWindowPage({ ...params, compactionId: "entry-compaction-1" });
    expect(page).toMatchObject({ messages: [shadowed], responseOffset: 1 });
    expect(readers.span).toHaveBeenCalledOnce();
    expect(readers.tail).not.toHaveBeenCalled();
  });

  it("preserves the ordinary unanchored local tail and its cursor", async () => {
    const page = await readChatHistoryWindowPage(params);
    expect(page).toMatchObject({
      messages: [local],
      activeLeafEntryId: "local-leaf",
      deltaCursor: "local-cursor",
      pagination: { offset: 0, totalMessages: 1, rawPageMessages: 1 },
    });
    expect(readers.tail).toHaveBeenCalledWith(
      expect.not.objectContaining({ offset: expect.anything() }),
    );
    expect(readers.around).not.toHaveBeenCalled();
    expect(readers.span).not.toHaveBeenCalled();
  });
});
