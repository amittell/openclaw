// Telegram tests cover reply media source identity across ingress and provider delivery.
import { describe, expect, it, vi } from "vitest";
import { setNextSavedMediaPath } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions, mockTelegramPngDownload } from "./bot.media.test-utils.js";

describe("telegram reply media source identity", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "attaches one image when current and replied messages stage one source at different paths",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = "/tmp/media/inbound/original-source.png";
      const currentPath = "/tmp/media/inbound/current-source.png";
      const originalMessage = {
        message_id: 1101,
        chat: { id: 1234, type: "private" as const },
        from: { id: 777, is_bot: false, first_name: "Ada" },
        photo: [{ file_id: "original-file", file_unique_id: "shared-telegram-source" }],
        date: 1736380800,
      };

      try {
        setNextSavedMediaPath({ path: originalPath, contentType: "image/png" });
        await handler({
          message: originalMessage,
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        setNextSavedMediaPath({ path: currentPath, contentType: "image/png" });
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me: { id: 999, username: "openclaw_bot" },
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const replyCall = replySpy.mock.calls[0];
        if (!replyCall) {
          throw new Error("expected one reply call");
        }
        expect(replyCall[0]).toMatchObject({ MediaPaths: [currentPath] });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attaches one image when two reply ancestors stage one source at different paths",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const chat = { id: 4321, type: "private" as const };
      const from = { id: 778, is_bot: false, first_name: "Ada" };
      const me = { id: 999, username: "openclaw_bot" };
      const rootMessage = {
        message_id: 1201,
        chat,
        from,
        photo: [{ file_id: "root-file", file_unique_id: "chain-telegram-source" }],
        date: 1736380800,
      };
      const middleMessage = {
        message_id: 1202,
        chat,
        from,
        photo: [{ file_id: "middle-file", file_unique_id: "chain-telegram-source" }],
        reply_to_message: rootMessage,
        date: 1736380801,
      };

      try {
        setNextSavedMediaPath({ path: "/tmp/media/inbound/root.png", id: "chain-root" });
        await handler({
          message: rootMessage,
          me,
          getFile: async () => ({ file_path: "photos/root.png" }),
        });

        setNextSavedMediaPath({ path: "/tmp/media/inbound/middle.png", id: "chain-middle" });
        await handler({
          message: middleMessage,
          me,
          getFile: async () => ({ file_path: "photos/middle.png" }),
        });

        replySpy.mockClear();
        await handler({
          message: {
            message_id: 1203,
            chat,
            from,
            text: "what is this?",
            reply_to_message: middleMessage,
            date: 1736380802,
          },
          me,
          getFile: async () => ({ file_path: "photos/unused.png" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const replyCall = replySpy.mock.calls[0];
        if (!replyCall) {
          throw new Error("expected one reply call");
        }
        // Both ancestors carry one Telegram source. Only the nearest may hydrate;
        // the second must be recognised through the media ref the first produced.
        expect(replyCall[0]).toMatchObject({
          MediaPaths: ["media://inbound/chain-middle"],
        });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
