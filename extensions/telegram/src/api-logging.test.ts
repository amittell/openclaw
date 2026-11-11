import { Api, HttpError } from "grammy";
import { assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  getOrCreateAccountThrottler,
  releaseAccountThrottler,
  runReplaceableTelegramRequest,
} from "./account-throttler.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { sendTypingTelegram } from "./send-actions.js";

const logs = vi.hoisted(() => ({ apiError: vi.fn() }));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "telegram/api" ? { ...logger, error: logs.apiError } : logger;
    },
  };
});

beforeEach(() => {
  logs.apiError.mockClear();
});

describe("Telegram API error logging", () => {
  it("retains safe transport diagnostics through grammY without logging nested request data", async () => {
    const cause = Object.assign(new Error("https://example.test/bot-private-token request body"), {
      code: "ECONNRESET",
      syscall: "read",
      address: "private-host",
    });
    const error = new HttpError(
      "Network request failed: https://example.test/bot-private-token request body",
      new TypeError("fetch failed", { cause }),
    );
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: async () => {
          throw error;
        },
        logger,
      }),
    ).rejects.toBe(error);

    expect(logger).toHaveBeenCalledExactlyOnceWith(
      `telegram sendMessage failed: network request failed transport={"code":"ECONNRESET","syscall":"read"}`,
    );
  });

  it("does not serialize arbitrary cause fields as transport diagnostics", async () => {
    const error = new HttpError("Network request for 'sendMessage' failed!", {
      code: "https://example.test/bot-private-token",
      syscall: "private request body",
      cause: { code: "UND_ERR_SOCKET", syscall: "connect" },
    });
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: async () => {
          throw error;
        },
        runtime: { error: logger },
      }),
    ).rejects.toBe(error);

    expect(logger).toHaveBeenCalledExactlyOnceWith(
      `telegram sendMessage failed: network request failed transport={"code":"UND_ERR_SOCKET","syscall":"connect"}`,
    );
  });
});

const refusal = (error_code: number, description: string, retry_after?: number) =>
  new Response(JSON.stringify({ ok: false, error_code, description, parameters: { retry_after } }));
const typingContext = async (api: Api, token: string) => {
  const { chatActions } = getOrCreateAccountThrottler(token);
  const cues: Promise<unknown>[] = [];
  const context = await buildTelegramMessageContextForTest({
    message: { chat: { id: 42, type: "private" } },
    // Mirrors bot-core: the account's chat-action guard around the bot's own API.
    sendChatActionHandler: {
      ...chatActions,
      sendChatAction: (chatId, action, threadParams) => {
        const sent = chatActions.sendChatAction(chatId, action, threadParams, () =>
          api.sendChatAction(chatId, action, threadParams),
        );
        cues.push(sent.catch(() => {}));
        return sent;
      },
    },
  });
  assert(context);
  // Building the context sends an early typing cue. Let it land, then step past
  // its same-chat coalescing window so the next typing reaches the limiter.
  await Promise.all(cues);
  vi.setSystemTime(Date.now() + TELEGRAM_CHAT_ACTION_INTERVAL_MS);
  return context;
};

it.each([
  [
    "sendChatAction",
    "inbound",
    async (api: Api, token: string) => (await typingContext(api, token)).sendTyping,
  ],
  [
    "sendChatAction",
    "recovered topic",
    async (api: Api, token: string) => {
      // Topic recovery reads only thread facts; a private-chat context keeps
      // forum topic-name lookups (plugin state) out of this test.
      const context = await typingContext(api, token);
      context.ctxPayload.MessageThreadId = 77;
      const forumGeneral = { ...context, threadSpec: { scope: "forum" as const, id: 1 } };
      return (await resolveDispatchTelegramContext({ context: forumGeneral })).sendTyping;
    },
  ],
  [
    "typing",
    "outbound",
    async (api: Api, token: string) => () =>
      sendTypingTelegram("42", {
        cfg: { channels: { telegram: { botToken: token } } },
        api,
        retry: { attempts: 1 },
      }),
  ],
] as const)(
  "logs %s failures from Telegram but not %s typing a flood wait held back",
  async (operation, entry, createSendTyping) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const token = `123:typing-${entry.replace(" ", "-")}`;
    onTestFinished(async () => {
      vi.useRealTimers();
      await releaseAccountThrottler(token);
    });
    // The inbound cases' early typing cue takes the first reply.
    const earlyCue = entry === "outbound" ? [] : ["sendChatAction"];
    const replies = [
      ...earlyCue.map(() => new Response(JSON.stringify({ ok: true, result: true }))),
      refusal(429, "Too Many Requests: retry after 30", 30),
      refusal(429, "Too Many Requests: retry after 5", 5),
      refusal(400, "Bad Request: chat not found"),
    ];
    const methods: string[] = [];
    const api = new Api(token, {
      fetch: asTelegramClientFetch(async (input: unknown) => {
        methods.push(String(input).slice(String(input).lastIndexOf("/") + 1));
        return replies.shift()!;
      }),
    });
    api.config.use(
      getOrCreateAccountThrottler(
        token,
        () => (prev, method, payload, signal) => prev(method, payload, signal),
      ).transformer,
    );
    const sendTyping = await createSendTyping(api, token);

    // Telegram floods a preview edit, so the account limiter holds the next typing back.
    await expect(
      runReplaceableTelegramRequest(() => api.editMessageText(42, 7, "preview")),
    ).rejects.toMatchObject({ error_code: 429 });
    await expect(sendTyping()).rejects.toMatchObject({ error_code: 429 });
    vi.setSystemTime(Date.now() + 31_000);
    await expect(sendTyping()).rejects.toMatchObject({ error_code: 429 });
    vi.setSystemTime(Date.now() + 31_000);
    await expect(sendTyping()).rejects.toMatchObject({ error_code: 400 });

    expect(methods).toEqual([...earlyCue, "editMessageText", "sendChatAction", "sendChatAction"]);
    expect(logs.apiError.mock.calls).toEqual([
      [
        `telegram ${operation} failed: Call to 'sendChatAction' failed! (429: Too Many Requests: retry after 5)`,
      ],
      [
        `telegram ${operation} failed: Call to 'sendChatAction' failed! (400: Bad Request: chat not found)`,
      ],
    ]);
  },
);

it("logs a final the flood wait kept from Telegram past the delivery budget", async () => {
  const token = "123:final-over-budget";
  onTestFinished(async () => {
    await releaseAccountThrottler(token);
  });
  const methods: string[] = [];
  const api = new Api(token, {
    fetch: asTelegramClientFetch(async (input: unknown) => {
      methods.push(String(input).slice(String(input).lastIndexOf("/") + 1));
      return refusal(429, "Too Many Requests: retry after 600", 600);
    }),
  });
  api.config.use(
    getOrCreateAccountThrottler(
      token,
      () => (prev, method, payload, signal) => prev(method, payload, signal),
    ).transformer,
  );

  // A ten-minute flood on a preview edit outlasts the five-minute budget a final may wait.
  await expect(
    runReplaceableTelegramRequest(() => api.editMessageText(42, 7, "preview")),
  ).rejects.toMatchObject({ error_code: 429 });
  await expect(
    withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: () => api.sendMessage(42, "final"),
    }),
  ).rejects.toMatchObject({ error_code: 429 });

  expect(methods).toEqual(["editMessageText"]);
  expect(logs.apiError.mock.calls).toEqual([
    [
      "telegram sendMessage failed: Call to 'sendMessage' failed! (429: Too Many Requests: retry after 600 (flood wait exceeds delivery budget; request not sent))",
    ],
  ]);
});
