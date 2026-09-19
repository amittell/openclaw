// Telegram plugin module tracks outgoing media upload size for size-aware request timeouts.
import { AsyncLocalStorage } from "node:async_hooks";

const telegramMediaUploadSizeStore = new AsyncLocalStorage<number>();

/**
 * Runs `fn` with the outgoing media upload size visible to the Telegram client
 * fetch wrapper, which sizes the request timeout for media send methods.
 */
export async function withTelegramMediaUploadSize<T>(
  fileSizeBytes: number,
  fn: () => Promise<T>,
): Promise<T> {
  return telegramMediaUploadSizeStore.run(fileSizeBytes, fn);
}

/** Returns the outgoing media upload size in bytes for the current async context, if any. */
export function getTelegramMediaUploadSize(): number | undefined {
  const size = telegramMediaUploadSizeStore.getStore();
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined;
}
