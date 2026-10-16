import type { TelegramMediaRef } from "./bot-message-context.types.js";
import type { TelegramReplyTarget } from "./bot/helpers.js";
import type { TelegramReplyChainEntry } from "./message-cache-codec.js";

export function replyTargetToChainEntry(
  replyTarget: TelegramReplyTarget,
  media?: TelegramMediaRef,
): TelegramReplyChainEntry {
  return {
    ...(replyTarget.id ? { messageId: replyTarget.id } : {}),
    sender: replyTarget.sender,
    ...(replyTarget.senderId ? { senderId: replyTarget.senderId } : {}),
    ...(replyTarget.senderUsername ? { senderUsername: replyTarget.senderUsername } : {}),
    ...(replyTarget.body ? { body: replyTarget.body } : {}),
    ...(replyTarget.mediaType
      ? { mediaKind: replyTarget.mediaType, mediaType: replyTarget.mediaType }
      : {}),
    ...(media?.path
      ? {
          mediaPath: media.path,
          mediaKind: media.kind,
          ...(media.contentType ? { mediaType: media.contentType } : {}),
        }
      : {}),
    ...(replyTarget.kind === "quote" ? { isQuote: true } : {}),
    ...(replyTarget.forwardedFrom?.from ? { forwardedFrom: replyTarget.forwardedFrom.from } : {}),
    ...(replyTarget.forwardedFrom?.fromId
      ? { forwardedFromId: replyTarget.forwardedFrom.fromId }
      : {}),
    ...(replyTarget.forwardedFrom?.fromUsername
      ? { forwardedFromUsername: replyTarget.forwardedFrom.fromUsername }
      : {}),
    ...(replyTarget.forwardedFrom?.date
      ? { forwardedDate: replyTarget.forwardedFrom.date * 1000 }
      : {}),
  };
}

// Hydrated reply media is typed from the saved file. The reply target only carries
// Telegram's native kind (`document` for an image sent as a file), so it must not
// replace that type.
export function withoutNativeReplyMedia(entry: TelegramReplyChainEntry | undefined) {
  if (!entry) {
    return undefined;
  }
  const { mediaKind: _mediaKind, mediaType: _mediaType, ...rest } = entry;
  return rest;
}
