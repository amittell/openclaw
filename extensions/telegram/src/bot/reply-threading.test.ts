import { describe, expect, it, vi } from "vitest";
import { createDeliveryProgress, sendChunkedTelegramReplyText } from "./reply-threading.js";

describe("sendChunkedTelegramReplyText", () => {
  it("preserves reply target and buttons until a chunk is actually sent", async () => {
    const progress = { ...createDeliveryProgress(), deliveredCount: 0 };
    const sendChunk = vi
      .fn<
        (opts: {
          chunk: string;
          isFirstChunk: boolean;
          replyToMessageId?: number;
          replyMarkup?: { inline_keyboard: unknown[] };
          replyQuoteText?: string;
        }) => Promise<boolean>
      >()
      .mockImplementation(async ({ chunk }) => chunk !== "skip");

    await sendChunkedTelegramReplyText({
      chunks: ["skip", "sent", "after"],
      progress,
      replyToId: 77,
      replyToMode: "first",
      replyMarkup: { inline_keyboard: [] },
      markDelivered: (state) => {
        state.hasDelivered = true;
        state.deliveredCount += 1;
      },
      sendChunk,
    });

    expect(sendChunk).toHaveBeenCalledTimes(3);
    expect(sendChunk.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        replyToMessageId: 77,
        replyMarkup: { inline_keyboard: [] },
      }),
    );
    expect(sendChunk.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        replyToMessageId: 77,
        replyMarkup: { inline_keyboard: [] },
      }),
    );
    expect(sendChunk.mock.calls[2]?.[0]).toEqual(
      expect.not.objectContaining({
        replyToMessageId: 77,
      }),
    );
    expect(sendChunk.mock.calls[2]?.[0]).toEqual(
      expect.not.objectContaining({
        replyMarkup: { inline_keyboard: [] },
      }),
    );
    expect(progress.hasReplied).toBe(true);
    expect(progress.hasDelivered).toBe(true);
    expect(progress.deliveredCount).toBe(2);
  });
});
