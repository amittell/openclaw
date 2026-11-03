// Transcript file state tests cover tolerant JSONL reads, malformed entries,
// branch leaf recovery, and repair-supported legacy payload shapes.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionManager } from "../sessions/index.js";
import { textToolResult } from "../test-helpers/sparse-transcript.test-support.js";
import {
  cleanupTranscriptFixtureRoots,
  readTranscriptState,
  writeTranscriptFixture,
} from "./transcript-file-state.test-support.js";

async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: SessionManager;
  appendedEntries: unknown[];
}): Promise<void> {
  const entries = params.state.migrated
    ? params.state.getPersistedEntries()
    : params.appendedEntries;
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (params.state.migrated) {
    await fs.writeFile(params.sessionFile, content, "utf8");
  } else {
    await fs.appendFile(params.sessionFile, content, "utf8");
  }
}

afterEach(async () => {
  await cleanupTranscriptFixtureRoots();
});

describe("readTranscriptState", () => {
  it("normalizes appended session names to one line", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-name-", [], {
      timestamp: "2026-07-16T00:00:00.000Z",
    });
    const state = await readTranscriptState(sessionFile);

    const entry = state.getEntry(state.appendSessionInfo("  first\nsecond\r\nthird  "))!;

    expect(entry).toMatchObject({ name: "first second third" });
    expect(state.getEntries().at(-1)).toMatchObject({ name: "first second third" });
  });

  it("preserves repair-supported assistant tool call payload shapes", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-tool-input-", [
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { role: "user", content: "read a file" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        parentId: "user-1",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", id: "call-input", name: "read", input: { path: "README.md" } },
            { type: "toolCall", id: "call-args", name: "write", arguments: { path: "out" } },
            { type: "toolUse", id: "call-no-args", name: "list" },
            {
              type: "function_call",
              call_id: "call-legacy",
              name: "search",
              arguments: '{"query":"docs"}',
            },
            { type: "toolCall", id: "call-null-args", name: "noop", arguments: null },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tool-result",
        parentId: "assistant-tool",
        timestamp: "2026-05-16T00:00:03.000Z",
        message: textToolResult("call-input", "read", "contents", { isError: false }),
      }),
    ]);

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-tool",
      "tool-result",
    ]);
    expect(state.getLeafId()).toBe("tool-result");
    expect(state.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("canonicalizes opaque append parents before a legacy migration rewrite", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-v1-opaque-parent-",
      [
        {
          type: "message",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "legacy active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "missing-before-migration",
        },
      ].map((entry) => JSON.stringify(entry)),
      { version: 1, timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const activeLeafId = state.getLeafId();
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(state.migrated).toBe(true);
    expect(appended.parentId).toBe(activeLeafId);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([activeLeafId, appended.id]);
  });

  it("breaks cycles between canonical and opaque rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-canonical-opaque-cycle-",
      [
        {
          type: "message",
          id: "active-entry",
          parentId: "opaque-cycle",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "kept through cycle" },
        },
        {
          type: "metadata",
          id: "opaque-cycle",
          parentId: "active-entry",
          payload: { source: "plugin" },
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
      { id: "active-entry", parentId: null },
    ]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "kept through cycle" },
    ]);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    expect(appended.parentId).toBe("active-entry");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-entry", appended.id]);
  });

  it("drops labels targeting rejected entries before transcript rewrite replay", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-rejected-label-", [
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
        id: "user-2",
        parentId: "bad-message",
        timestamp: "2026-05-16T00:00:03.000Z",
        message: { role: "user", content: "after malformed row" },
      }),
      JSON.stringify({
        type: "label",
        id: "label-1",
        parentId: "user-2",
        timestamp: "2026-05-16T00:00:04.000Z",
        targetId: "bad-message",
        label: "bad",
      }),
      JSON.stringify({
        type: "message",
        id: "user-3",
        parentId: "label-1",
        timestamp: "2026-05-16T00:00:05.000Z",
        message: { role: "user", content: "after poisoned label" },
      }),
    ]);

    const state = await readTranscriptState(sessionFile);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [
        { id: "user-1", parentId: null },
        { id: "user-2", parentId: "user-1" },
        { id: "user-3", parentId: "user-2" },
      ],
    );
    expect(state.getLabel("bad-message")).toBeUndefined();
  });

  it("applies leaf controls to active state and marker-linked descendants", async () => {
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-16T00:00:01.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-05-16T00:00:02.000Z",
      message: { role: "assistant", content: "abandoned answer" },
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-05-16T00:00:03.000Z",
      targetId: rootEntry.id,
    };
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-leaf-",
      [rootEntry, abandonedEntry, leafEntry].map((entry) => JSON.stringify(entry)),
    );

    const selectedState = await readTranscriptState(sessionFile);
    expect(selectedState.getLeafId()).toBe(rootEntry.id);
    expect(selectedState.getBranch().map((entry) => entry.id)).toEqual([rootEntry.id]);

    const replacementEntry = {
      type: "message",
      id: "replacement-assistant",
      parentId: leafEntry.id,
      timestamp: "2026-05-16T00:00:04.000Z",
      message: { role: "assistant", content: "replacement answer" },
    };
    await fs.appendFile(sessionFile, `${JSON.stringify(replacementEntry)}\n`, "utf8");

    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getEntries().find((entry) => entry.id === replacementEntry.id)).toEqual(
      expect.objectContaining({ parentId: rootEntry.id }),
    );
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
      rootEntry.id,
      replacementEntry.id,
    ]);
  });

  it("keeps parentless canonical ancestry through rewrite replay", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-parentless-leaf-",
      [
        {
          type: "message",
          id: "user-1",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "question", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "answer", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "assistant-1",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "assistant-1",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
  });

  it("preserves marked side ancestry without capturing the next active append", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-side-append-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "message",
          id: "side-one",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "first side delivery" },
        },
        {
          type: "leaf",
          id: "first-leaf",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "side-one",
          appendMode: "side",
        },
        {
          type: "message",
          id: "side-two",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:04.000Z",
          appendMode: "side",
          message: { role: "assistant", content: "second side delivery" },
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch("side-two").map((entry) => entry.id)).toEqual([
      "active-root",
      "side-one",
      "side-two",
    ]);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root"]);
    expect(state.getLeafId()).toBe("active-root");
    expect(state.getAppendParentId()).toBe("side-two");
    expect(state.getAppendMode()).toBe("side");

    const nextUser = state.getEntry(
      state.appendMessage({ role: "user", content: "next question", timestamp: Date.now() }),
    )!;
    expect(state.getBranch(nextUser.id).map((entry) => entry.id)).toEqual([
      "active-root",
      nextUser.id,
    ]);
  });

  it("keeps a terminal leaf control's opaque append parent", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-opaque-append-parent-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: null,
          payload: { source: "plugin" },
        },
        {
          type: "message",
          id: "side-delivery",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "side delivery" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-delivery",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "plugin-metadata",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });
    const persisted = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.getLeafId()).toBe(appended.id);
    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    expect(persisted.at(-1)).toMatchObject({ id: appended.id, parentId: "active-root" });
  });

  it("ignores leaf controls with dangling target or append references", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-invalid-leaf-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-root",
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "missing-target",
          parentId: "plugin-metadata",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "missing",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getLeafId()).toBe(appended.id);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
  });
});
