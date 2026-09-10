import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  enrichChatHistoryCompactionMarkers,
  shouldReadAnchoredWindow,
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

describe("shouldReadAnchoredWindow", () => {
  const cli = "claude-cli-session-1";

  it("reads a compaction span even when the session has a CLI import binding", () => {
    // Regression: the span shares the anchored branch with offset/messageId, which
    // deliberately falls through to the CLI merge. Falling through here answered a
    // span request with the live tail and reported success, so the caller could not
    // tell the shadowed rows were never read.
    expect(
      shouldReadAnchoredWindow({
        offset: undefined,
        messageId: undefined,
        compactionId: "entry-compaction-1",
        cliSessionId: cli,
      }),
    ).toBe(true);
  });

  it("still lets offset and messageId fall through to the CLI merge", () => {
    for (const anchor of [
      { offset: 0, messageId: undefined },
      { offset: undefined, messageId: "entry-message-1" },
    ]) {
      expect(
        shouldReadAnchoredWindow({ ...anchor, compactionId: undefined, cliSessionId: cli }),
      ).toBe(false);
    }
  });

  it("reads anchored windows directly without a CLI binding", () => {
    for (const anchor of [
      { offset: 0, messageId: undefined, compactionId: undefined },
      { offset: undefined, messageId: "entry-message-1", compactionId: undefined },
      { offset: undefined, messageId: undefined, compactionId: "entry-compaction-1" },
    ]) {
      expect(shouldReadAnchoredWindow({ ...anchor, cliSessionId: undefined })).toBe(true);
    }
  });

  it("leaves an unanchored tail read to the normal path", () => {
    expect(
      shouldReadAnchoredWindow({
        offset: undefined,
        messageId: undefined,
        compactionId: undefined,
        cliSessionId: undefined,
      }),
    ).toBe(false);
  });
});
