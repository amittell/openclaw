import type { TelegramMediaKind } from "./bot/body-helpers.js";

const TELEGRAM_MEDIA_KINDS = new Set<TelegramMediaKind>([
  "audio",
  "document",
  "image",
  "sticker",
  "video",
]);

export function isTelegramMediaKind(value: string): value is TelegramMediaKind {
  // SAFETY: Set.has only reads; a non-member string returns false, which is exactly this predicate's contract.
  return TELEGRAM_MEDIA_KINDS.has(value as TelegramMediaKind);
}
