// Telegram tests cover size-aware upload deadlines against grammY's client timer.
import { InputFile, type Transformer } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBot } from "./bot.js";
import { withTelegramMediaUploadSize } from "./media-upload-size.js";
import { withTelegramApiContext } from "./send-context.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";

const { resolveTelegramTransport } = vi.hoisted(() => ({
  resolveTelegramTransport: vi.fn(),
}));

vi.mock("./fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch.js")>()),
  resolveTelegramTransport,
}));

// The account throttler queues through Bottleneck's setTimeout, and vitest's fake
// timers do not carry AsyncLocalStorage across it, so the caller's upload size
// would read as unknown here. Real timers carry it; pass the throttler through.
vi.mock("./bot.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot.runtime.js")>()),
  apiThrottler: (): Transformer => (prev, method, payload, signal) => prev(method, payload, signal),
}));

const MIB = 1024 * 1024;
const cfg = { channels: { telegram: { botToken: "123456:upload-deadline-fixture" } } };

// grammY races every call against its own client timer (500 s unless
// client.timeoutSeconds is set). Guards are ceil(bytes / 2 MiB/s) + 60 s.
const UPLOADS = [
  { size: "1 GiB", uploadBytes: 1024 * MIB, guardMs: 572_000 },
  // mediaMaxMb 2000 is the largest file the self-hosted host accepts.
  { size: "2000 MiB", uploadBytes: 2000 * MIB, guardMs: 1_060_000 },
];

describe("Telegram media upload deadline against grammY's client timer", () => {
  const aborts: Array<{ method: string; afterMs: number; reason: string }> = [];

  // Stands in for a Bot API server that is still relaying the file to Telegram.
  const pendingUploadFetch = (url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const startedAt = Date.now();
      init?.signal?.addEventListener(
        "abort",
        () => {
          const reason: unknown = init.signal?.reason;
          const error = reason instanceof Error ? reason : new Error("aborted");
          aborts.push({
            method: url.split("/").at(-1) ?? "",
            afterMs: Date.now() - startedAt,
            reason: error.message,
          });
          reject(error);
        },
        { once: true },
      );
    });

  const upload = (fileName: string) => new InputFile(Buffer.from("x"), fileName);

  beforeEach(() => {
    vi.useFakeTimers();
    aborts.length = 0;
    resetTelegramClientOptionsCacheForTests();
    resolveTelegramTransport.mockReturnValue({
      fetch: pendingUploadFetch as typeof fetch,
      sourceFetch: pendingUploadFetch as typeof fetch,
      close: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.useRealTimers();
  });

  it.each(UPLOADS)("keeps a $size send upload open until its size guard", async (item) => {
    const outcome = withTelegramApiContext({ cfg }, ({ api }) =>
      withTelegramMediaUploadSize(item.uploadBytes, () =>
        api.sendDocument("123", upload("disk.img")),
      ),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(item.guardMs + 5_000);

    expect(aborts).toEqual([
      {
        method: "sendDocument",
        afterMs: item.guardMs,
        reason: `Telegram senddocument timed out after ${item.guardMs}ms`,
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });

  it.each(UPLOADS)("keeps a $size polling bot upload open until its size guard", async (item) => {
    // polling-session.ts passes the 45s getUpdates guard as this minimum.
    const bot = createTelegramBot({
      token: cfg.channels.telegram.botToken,
      config: cfg,
      minimumClientTimeoutSeconds: 45,
    });
    const outcome = withTelegramMediaUploadSize(item.uploadBytes, () =>
      bot.api.sendVideo(123, upload("clip.mp4")),
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(item.guardMs + 5_000);

    expect(aborts).toEqual([
      {
        method: "sendVideo",
        afterMs: item.guardMs,
        reason: `Telegram sendvideo timed out after ${item.guardMs}ms`,
      },
    ]);
    await expect(outcome).resolves.toBeInstanceOf(Error);
  });
});
