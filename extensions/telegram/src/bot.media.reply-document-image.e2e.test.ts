import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { readRemoteMediaBufferSpy, setNextSavedMediaPath } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions } from "./bot.media.test-utils.js";

// A decodable 1x1 JPEG, so the prompt image loader treats the staged file as a real image.
const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQF" +
    "BgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkK" +
    "FhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZ" +
    "mqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEB" +
    "AQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEI" +
    "FEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3" +
    "eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq" +
    "8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4O" +
    "Dg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ" +
    "EBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwDuKKKK/wBAD5c//9k=",
  "base64",
);

function stageInboundFile(id: string, bytes: Buffer): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("media harness state dir is not set");
  }
  const inboundDir = path.join(stateDir, "media", "inbound");
  mkdirSync(inboundDir, { recursive: true });
  const filePath = path.join(inboundDir, id);
  writeFileSync(filePath, bytes);
  return filePath;
}

async function countProviderImages(ctx: MsgContext): Promise<number> {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
  // The same SDK loader agent harnesses use to build provider image input.
  const { images } = await detectAndLoadAgentHarnessPromptImages({
    prompt: "",
    workspaceDir: stateDir,
    model: { input: ["text", "image"] },
    media: ctx.media,
    localRoots: [stateDir],
  });
  return images.length;
}

const chat = { id: 1234, type: "private" as const };
const from = { id: 777, is_bot: false, first_name: "Ada" };
const me = { id: 999, username: "openclaw_bot" };
// An image sent with Telegram's "send as file": the update carries a `document`, not a photo.
const documentMessage = {
  message_id: 1201,
  chat,
  from,
  date: 1736380800,
  caption: "Weekly chart",
  document: {
    file_id: "chart-file",
    file_unique_id: "chart-source",
    file_name: "chart.jpg",
    mime_type: "image/jpeg",
  },
};

describe("telegram reply to an image sent as a document", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "keeps the replied file an image from ingress to the provider image payload",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const chartPath = stageInboundFile("chart.jpg", JPEG_BYTES);
      readRemoteMediaBufferSpy.mockResolvedValue({
        buffer: JPEG_BYTES,
        contentType: "image/jpeg",
        fileName: "chart.jpg",
      });

      setNextSavedMediaPath({ path: chartPath, id: "chart.jpg", contentType: "image/jpeg" });
      await handler({
        message: documentMessage,
        me,
        getFile: async () => ({ file_path: "documents/chart.jpg" }),
      });

      replySpy.mockClear();
      await handler({
        message: {
          message_id: 1202,
          chat,
          from,
          date: 1736380801,
          text: "What does it show?",
          reply_to_message: documentMessage,
        },
        me,
        getFile: async () => ({ file_path: "documents/chart.jpg" }),
      });

      expect(runtimeError).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
      const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
      if (!ctx) {
        throw new Error("expected one reply call");
      }
      expect(ctx.media).toEqual([
        expect.objectContaining({ kind: "image", contentType: "image/jpeg" }),
      ]);
      expect(await countProviderImages(ctx)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
