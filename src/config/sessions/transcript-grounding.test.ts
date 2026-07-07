import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNGROUNDED_MEDIA_PLACEHOLDER, redactUngroundedMediaRefs } from "./transcript-grounding.js";
import { readRecentUserAssistantTextFromSessionTranscript } from "./transcript.js";

describe("redactUngroundedMediaRefs", () => {
  const mediaDir = "/managed/state/media";
  const never = () => false;

  it("redacts a fabricated managed-media path and keeps the prose", () => {
    const text = `IMAGE:${mediaDir}/whats-app-image-2026-07-06-909898742550877-194.jpg That's a serious setup, Ally.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir, exists: never });
    expect(redacted).toBe(`IMAGE:${UNGROUNDED_MEDIA_PLACEHOLDER} That's a serious setup, Ally.`);
  });

  it("keeps managed-media paths that resolve to real files", () => {
    const real = `${mediaDir}/inbound/photo.jpg`;
    const text = `See ${real} for the original.`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir,
      exists: (candidate) => candidate === real,
    });
    expect(redacted).toBe(text);
  });

  it("never touches absolute paths outside the managed media dir", () => {
    const text = "The bug is in /Users/alex/git/openclaw/src/missing-file.ts and /tmp/foo.log.";
    expect(redactUngroundedMediaRefs(text, { mediaDir, exists: never })).toBe(text);
  });

  it("returns the same reference when nothing needs redacting", () => {
    const text = "No paths here.";
    expect(redactUngroundedMediaRefs(text, { mediaDir, exists: never })).toBe(text);
  });

  it("handles the macOS /private twin of a /var media dir", () => {
    const varDir = "/var/state/media";
    const text = `Saved to /private/var/state/media/inbound/fake.png earlier.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir: varDir, exists: never });
    expect(redacted).toBe(`Saved to ${UNGROUNDED_MEDIA_PLACEHOLDER} earlier.`);
  });

  it("leaves trailing sentence punctuation attached to the prose", () => {
    const text = `I attached ${mediaDir}/fake.png.`;
    const redacted = redactUngroundedMediaRefs(text, { mediaDir, exists: never });
    expect(redacted).toBe(`I attached ${UNGROUNDED_MEDIA_PLACEHOLDER}.`);
  });

  it("redacts every fabricated ref while keeping the verified one", () => {
    const real = `${mediaDir}/inbound/real.jpg`;
    const text = `first ${mediaDir}/a.jpg then ${real} then ${mediaDir}/b.jpg`;
    const redacted = redactUngroundedMediaRefs(text, {
      mediaDir,
      exists: (candidate) => candidate === real,
    });
    expect(redacted).toBe(
      `first ${UNGROUNDED_MEDIA_PLACEHOLDER} then ${real} then ${UNGROUNDED_MEDIA_PLACEHOLDER}`,
    );
  });
});

describe("readRecentUserAssistantTextFromSessionTranscript grounding", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("grounds assistant text on replay but never rewrites user text", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-grounding-"));
    try {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      const mediaDir = path.join(tempDir, "media");
      const realFile = path.join(mediaDir, "inbound", "real.jpg");
      fs.mkdirSync(path.dirname(realFile), { recursive: true });
      fs.writeFileSync(realFile, "jpeg-bytes");
      const fakeFile = path.join(mediaDir, "whats-app-image-909898742550877.jpg");

      const sessionFile = path.join(tempDir, "session.jsonl");
      const lines = [
        {
          id: "u1",
          message: {
            role: "user",
            timestamp: 1,
            content: [{ type: "text", text: `user mentions ${fakeFile} verbatim` }],
          },
        },
        {
          id: "a1",
          message: {
            role: "assistant",
            timestamp: 2,
            content: [
              {
                type: "text",
                text: `IMAGE:${fakeFile} That's a serious setup. Original at ${realFile}.`,
              },
            ],
          },
        },
      ];
      fs.writeFileSync(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

      const entries = await readRecentUserAssistantTextFromSessionTranscript(sessionFile, {
        limit: 10,
      });
      const user = entries.find((entry) => entry.role === "user");
      const assistant = entries.find((entry) => entry.role === "assistant");
      expect(user?.text).toBe(`user mentions ${fakeFile} verbatim`);
      expect(assistant?.text).toBe(
        `IMAGE:${UNGROUNDED_MEDIA_PLACEHOLDER} That's a serious setup. Original at ${realFile}.`,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
