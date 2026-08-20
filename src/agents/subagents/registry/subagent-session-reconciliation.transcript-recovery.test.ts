// Regression coverage for the transcript fallback in recovered child
// completion: a gateway restart mid-flush can leave the persisted session
// entry unended while the child's JSONL transcript already holds a final
// assistant reply.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSessionTranscriptPathInDir } from "../../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSubagentRecoveryCompletion } from "./subagent-session-reconciliation.js";

const CHILD_SESSION_KEY = "agent:main:subagent:transcript-child";
const SESSION_ID = "sess-transcript-recovery";

let tempRoot = "";
let tempStoreIndex = 0;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-subagent-transcript-recovery-"));
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

type CaseFixture = {
  cfg: OpenClawConfig;
  sessionsDir: string;
  storePath: string;
  transcriptPath: string;
};

async function seedStoreEntry(entry: SessionEntry): Promise<CaseFixture> {
  tempStoreIndex += 1;
  const sessionsDir = path.join(tempRoot, `${tempStoreIndex}-sessions`);
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  await replaceSessionEntry({ storePath, sessionKey: CHILD_SESSION_KEY }, entry);
  return {
    cfg: { session: { store: storePath } } as OpenClawConfig,
    sessionsDir,
    storePath,
    transcriptPath: resolveSessionTranscriptPathInDir(SESSION_ID, sessionsDir),
  };
}

function writeTranscript(fixture: CaseFixture, lines: unknown[]): void {
  fs.writeFileSync(
    fixture.transcriptPath,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
  );
}

const assistantText = (text: string) => ({ message: { role: "assistant", content: text } });
const assistantToolCall = (id: string) => ({
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "working" },
      { type: "toolCall", id, name: "read", input: { path: "notes.md" } },
    ],
  },
});
const userTurn = (text: string) => ({ message: { role: "user", content: text } });

const resolve = (fixture: CaseFixture) =>
  resolveSubagentRecoveryCompletion({
    childSessionKey: CHILD_SESSION_KEY,
    fallbackEndedAt: 10_000,
    notBeforeMs: 1_000,
    cfg: fixture.cfg,
  });

describe("resolveSubagentRecoveryCompletion transcript fallback", () => {
  it("recovers ok completion from a final assistant reply when the entry has no status", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);
    writeTranscript(fixture, [userTurn("run the check"), assistantText("check finished ok")]);

    expect(resolve(fixture)).toEqual({
      endedAt: 10_000,
      outcome: { status: "ok" },
      reason: "subagent-complete",
    });
  });

  it("accepts block-list content with text blocks only", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);
    writeTranscript(fixture, [
      assistantToolCall("call_1"),
      { message: { role: "toolResult", toolCallId: "call_1", content: "done" } },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final summary" }],
          stopReason: "stop",
        },
      },
    ]);

    expect(resolve(fixture)?.outcome).toEqual({ status: "ok" });
  });

  it("returns null when the latest assistant reply is still waiting on a tool call", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);
    writeTranscript(fixture, [userTurn("go"), assistantToolCall("call_2")]);

    expect(resolve(fixture)).toBeNull();
  });

  it("returns null when the latest assistant reply ended in an error stop reason", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);
    writeTranscript(fixture, [
      { message: { role: "assistant", content: "partial", stopReason: "error" } },
    ]);

    expect(resolve(fixture)).toBeNull();
  });

  it("returns null when a newer user turn started after the last assistant reply", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);
    writeTranscript(fixture, [assistantText("first reply"), userTurn("next question")]);

    expect(resolve(fixture)).toBeNull();
  });

  it("prefers the persisted entry completion over the transcript fallback", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      status: "done",
      startedAt: 2_000,
      endedAt: 9_000,
      updatedAt: 9_000,
    } as SessionEntry);
    // Transcript would also prove completion; the entry path must win.
    writeTranscript(fixture, [assistantText("unused")]);

    expect(resolve(fixture)).toEqual({
      startedAt: 2_000,
      endedAt: 9_000,
      outcome: { status: "ok" },
      reason: "subagent-complete",
    });
  });

  it("returns null when the transcript file is missing", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      updatedAt: 9_000,
    } as SessionEntry);

    expect(resolve(fixture)).toBeNull();
  });

  it("returns null when the child session entry is missing from the store", async () => {
    // A fresh store with no row for the child key: no persisted identity means
    // no transcript to read, even if an orphan file exists at the default path.
    tempStoreIndex += 1;
    const sessionsDir = path.join(tempRoot, `${tempStoreIndex}-missing-sessions`);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const storePath = path.join(sessionsDir, "sessions.json");
    const orphanPath = resolveSessionTranscriptPathInDir(SESSION_ID, sessionsDir);
    fs.writeFileSync(orphanPath, `${JSON.stringify(assistantText("orphan reply"))}\n`);

    expect(
      resolveSubagentRecoveryCompletion({
        childSessionKey: CHILD_SESSION_KEY,
        fallbackEndedAt: 10_000,
        notBeforeMs: 1_000,
        cfg: { session: { store: storePath } } as OpenClawConfig,
      }),
    ).toBeNull();
  });

  it("returns null for sqlite-backed transcript targets", async () => {
    const fixture = await seedStoreEntry({
      sessionId: SESSION_ID,
      sessionFile: "sqlite:agents/main",
      updatedAt: 9_000,
    } as SessionEntry);

    expect(resolve(fixture)).toBeNull();
  });
});
