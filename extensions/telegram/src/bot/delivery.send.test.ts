import type { Bot } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { describe, expect, it, vi } from "vitest";

vi.mock("grammy", () => ({
  API_CONSTANTS: {
    DEFAULT_UPDATE_TYPES: ["message"],
    ALL_UPDATE_TYPES: ["message"],
  },
  Bot: class Bot {},
  HttpError: class HttpError extends Error {},
  InputFile: class InputFile {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

const { sendTelegramText } = await import("./delivery.send.js");

type RuntimeStub = Pick<RuntimeEnv, "error" | "log" | "exit">;

function createRuntime(): RuntimeStub {
  return {
    error: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
  };
}

function createBot(sendMessage: ReturnType<typeof vi.fn>): Bot {
  return { api: { sendMessage } } as unknown as Bot;
}

// The "interrupted mid-reply turn" delivery shape: the model emits an HTML chunk that
// looks non-empty locally (bare <br>, &nbsp;, etc.) but Telegram's supported-tag filter
// strips it to nothing and returns a 400. The delivery contract passes plainText=""
// for these chunks because the model produced no human-visible source text either.
// Before this fix, the post-call 400 surfaced as a delivery failure; after the fix,
// the send is skipped silently. Empty/whitespace-only chunks are caught pre-flight
// (no API call). Tags that survive trim locally but Telegram strips server-side
// (bare <br>, &nbsp;) trigger one API attempt then the catch-side silent skip.
const EMPTY_HTML_PAYLOADS = [
  { label: "empty string after trim", htmlText: "   ", expectedApiCalls: 0 },
  { label: "bare <br> chunk", htmlText: "<br>", expectedApiCalls: 1 },
  { label: "self-closing <br/> chunk", htmlText: "<br/>", expectedApiCalls: 1 },
  { label: "spaced <br /> chunk", htmlText: "<br />", expectedApiCalls: 1 },
  { label: "nbsp-only payload", htmlText: "&nbsp;", expectedApiCalls: 1 },
  { label: "multiple nbsp payload", htmlText: "&nbsp;&nbsp;&nbsp;", expectedApiCalls: 1 },
];

describe("sendTelegramText empty-text silent skip", () => {
  for (const { label, htmlText, expectedApiCalls } of EMPTY_HTML_PAYLOADS) {
    it(`silently skips html ${label} when Telegram rejects as empty and no plain fallback`, async () => {
      // Telegram's supported-tag filter strips bare <br>/&nbsp; chunks to empty and
      // returns one of the documented "empty text" 400 descriptions. With no plain
      // fallback to retry against, the send must become a no-op rather than bubble
      // a 400 up to the delivery caller.
      const runtime = createRuntime();
      const sendMessage = vi.fn(async () => {
        throw new Error("400: Bad Request: message text is empty");
      });
      const bot = createBot(sendMessage);

      const result = await sendTelegramText(bot, "123", htmlText, runtime as RuntimeEnv, {
        textMode: "html",
        plainText: "",
      });

      expect(result).toBeUndefined();
      // expectedApiCalls=0 means the pre-flight trim-empty branch short-circuits
      // before any API call; expectedApiCalls=1 means the HTML send tries once,
      // Telegram returns the 400, and the catch-side silent-skip handles it.
      expect(sendMessage).toHaveBeenCalledTimes(expectedApiCalls);
    });
  }

  it("silently skips before any API call when html and plain fallback are both whitespace-only", async () => {
    // Pre-flight skip: trim of the formatted HTML and trim of the plain fallback are
    // both empty, so the no-op short-circuits before sendMessage is invoked.
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "   ", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "   \n\t  ",
    });

    expect(result).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("silently skips when Telegram rejects post-strip text with the newer 'text must be non-empty' wording", async () => {
    // Bot API variant observed alongside the legacy "message text is empty" wording.
    // The regex must catch both or this 400 escapes back to the delivery caller as
    // a hard failure that retries forever and pollutes the error log.
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: text must be non-empty");
    });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "<i></i>", runtime as RuntimeEnv, {
      textMode: "html",
      plainText: "",
    });

    expect(result).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("still throws for unrelated send failures", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn(async () => {
      throw new Error("400: Bad Request: chat not found");
    });
    const bot = createBot(sendMessage);

    await expect(
      sendTelegramText(bot, "123", "hello", runtime as RuntimeEnv, { textMode: "html" }),
    ).rejects.toThrow(/chat not found/);
  });

  it("still delivers when the formatted payload contains real content", async () => {
    const runtime = createRuntime();
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42, chat: { id: "123" } });
    const bot = createBot(sendMessage);

    const result = await sendTelegramText(bot, "123", "hello world", runtime as RuntimeEnv, {
      textMode: "markdown",
    });

    expect(result).toBe(42);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
