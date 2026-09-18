// Telegram tests cover upload deadlines through the real undici transport.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { InputFile, type Transformer } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTelegramMediaUploadSize } from "./media-upload-size.js";
import { withTelegramApiContext } from "./send-context.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";

// The account throttler queues through Bottleneck's setTimeout, and vitest's fake
// timers do not carry AsyncLocalStorage across it, so the caller's upload size
// would read as unknown here. Real timers carry it; pass the throttler through.
vi.mock("./bot.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bot.runtime.js")>()),
  apiThrottler: (): Transformer => (prev, method, payload, signal) => prev(method, payload, signal),
}));

// The 893.1 MiB incident file: ceil(bytes / 2 MiB/s) + 60 s is a 507 s guard.
const INCIDENT_UPLOAD_BYTES = 936_445_710;

// setImmediate stays real so socket I/O runs between fake-clock steps.
const flushIo = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

async function advanceUntil(done: () => boolean, stepMs: number, maxSteps: number) {
  for (let step = 0; !done() && step < maxSteps; step += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await flushIo();
  }
}

function innermostMessage(error: unknown): string | undefined {
  let current: unknown = error;
  let message: string | undefined;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const record = current as { message?: unknown; error?: unknown; cause?: unknown };
    message = typeof record.message === "string" ? record.message : message;
    current = record.error ?? record.cause;
  }
  return message;
}

describe("Telegram upload through the real transport", () => {
  let relay: http.Server | undefined;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetTelegramClientOptionsCacheForTests();
    relay?.closeAllConnections();
    await new Promise<void>((resolve) => {
      if (relay) {
        relay.close(() => resolve());
      } else {
        resolve();
      }
    });
    relay = undefined;
  });

  it("holds a self-hosted Bot API upload past undici's 300 s header wait", async () => {
    const seen: { bodyEndAt?: number; settledAt?: number; failure?: unknown } = {};
    // A self-hosted Bot API server reads the whole upload, then answers only
    // after it has relayed the file to Telegram.
    relay = http.createServer((req) => {
      req.resume();
      req.on("end", () => {
        seen.bodyEndAt = Date.now();
      });
    });
    const server = relay;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const cfg = {
      channels: {
        telegram: { botToken: "123456:relay-fixture", apiRoot: `http://127.0.0.1:${port}` },
      },
    };

    void withTelegramApiContext({ cfg }, ({ api }) =>
      withTelegramMediaUploadSize(INCIDENT_UPLOAD_BYTES, () =>
        api.sendDocument("123", new InputFile(Buffer.alloc(64 * 1024), "disk.img")),
      ),
    ).then(
      () => {
        seen.settledAt = Date.now();
      },
      (error: unknown) => {
        seen.failure = error;
        seen.settledAt = Date.now();
      },
    );

    await advanceUntil(() => seen.bodyEndAt !== undefined, 10, 500);
    await advanceUntil(() => seen.settledAt !== undefined, 250, 2_200);

    expect({
      reason: innermostMessage(seen.failure),
      afterSeconds:
        seen.settledAt === undefined || seen.bodyEndAt === undefined
          ? undefined
          : Math.round((seen.settledAt - seen.bodyEndAt) / 1000),
    }).toEqual({ reason: "Telegram senddocument timed out after 507000ms", afterSeconds: 507 });
  });
});
