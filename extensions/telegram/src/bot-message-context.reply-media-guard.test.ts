import type { Message } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { isTelegramMessageFromCurrentBot } from "./message-cache.js";

vi.mock("./sticker-vision.runtime.js", () => ({
  resolveStickerVisionSupportRuntime: vi.fn(async () => false),
}));

// Re-derive coverage for upstream PR #57280 (skip reply media from bot-authored
// messages) plus the beta.2 same-staged-file double-attach guard.
describe("telegram reply-media self-authored guard and dedupe", () => {
  const stagedPath =
    "/Users/test/.openclaw/workspace/media/inbound/openclaw-staged-0a9b/abcd1234-ef56-7890-abcd-123456789012.jpg";

  it("classifies a bot-authored source message as from the current bot", () => {
    const fromBot = {
      message_id: 12406,
      date: 1_700_000_000,
      chat: { id: 42, type: "private", first_name: "Ada" },
      from: { id: 7, is_bot: true, first_name: "OpenClaw" },
      photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
    } as unknown as Message;
    const fromUser = {
      ...fromBot,
      message_id: 12405,
      from: { id: 42, is_bot: false, first_name: "Ada" },
    } as unknown as Message;

    expect(isTelegramMessageFromCurrentBot(fromBot, 7)).toBe(true);
    expect(isTelegramMessageFromCurrentBot(fromUser, 7)).toBe(false);
    // Unknown bot identity falls back to the is_bot flag.
    expect(isTelegramMessageFromCurrentBot(fromBot, undefined)).toBe(true);
    expect(isTelegramMessageFromCurrentBot(fromUser, undefined)).toBe(false);
  });

  it("does not double-attach a reply-chain media fact that re-stages the current message file", async () => {
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        text: "Ok so why didn't you reply to this then?",
        reply_to_message: {
          message_id: 12406,
          date: 1_699_999_999,
          chat: { id: 42, type: "private", first_name: "Ada" },
          from: { id: 42, is_bot: false, first_name: "Ada" },
          photo: [{ file_id: "photo-1", file_unique_id: "photo-u1", width: 1, height: 1 }],
        },
      },
      // The reply-chain node re-resolved the same staged file as the current
      // message (same media://inbound id). The prompt must carry it once.
      allMedia: [{ kind: "image", path: stagedPath, contentType: "image/jpeg" }],
      replyChain: [
        {
          messageId: "12406",
          sender: "Ada",
          mediaKind: "image",
          mediaPath: stagedPath,
          mediaType: "image/jpeg",
        },
      ],
    });

    const media = context?.ctxPayload.media ?? [];
    const stagedFacts = media.filter((fact) => fact.path?.includes("abcd1234"));
    expect(stagedFacts).toHaveLength(1);
  });

  it("keeps distinct reply-chain media facts (different staged files)", async () => {
    const otherStagedPath =
      "/Users/test/.openclaw/workspace/media/inbound/openclaw-staged-0a9c/ffff0000-1111-2222-3333-444455556666.jpg";
    const context = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
        text: "compare these",
      },
      allMedia: [{ kind: "image", path: stagedPath, contentType: "image/jpeg" }],
      replyChain: [
        {
          messageId: "12405",
          sender: "Ada",
          mediaKind: "image",
          mediaPath: otherStagedPath,
          mediaType: "image/jpeg",
        },
      ],
    });

    const media = context?.ctxPayload.media ?? [];
    const paths = media.map((fact) => fact.path);
    expect(paths).toContain(stagedPath);
    expect(paths).toContain(otherStagedPath);
  });
});
