// Shares the JSONL transcript fixtures used by the transcript file-state suites.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionEntries, SessionManager } from "../sessions/index.js";

const roots: string[] = [];

export async function readTranscriptState(sessionFile: string): Promise<SessionManager> {
  return SessionManager.fromEntries(parseSessionEntries(await fs.readFile(sessionFile, "utf8")));
}

async function makeRoot(prefix: string): Promise<string> {
  // Each file-state case writes a full JSONL transcript under its own root so
  // orphan/leaf behavior stays isolated.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

export async function writeTranscriptFixture(
  prefix: string,
  entryLines: string[],
  header: { version?: number; timestamp?: string } = {},
): Promise<string> {
  const root = await makeRoot(prefix);
  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: header.version ?? 3,
        id: "session-1",
        timestamp: header.timestamp ?? "2026-05-16T00:00:00.000Z",
        cwd: root,
      }),
      ...entryLines,
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

/** Removes the fixture roots written since the last call; each suite runs it in afterEach. */
export async function cleanupTranscriptFixtureRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
}
