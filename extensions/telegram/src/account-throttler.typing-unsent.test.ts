// Telegram tests cover typing the account throttler holds back during a flood wait (#191687).
import { Api } from "grammy";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { getOrCreateAccountThrottler, runReplaceableTelegramRequest } from "./account-throttler.js";
import { asTelegramClientFetch } from "./client-fetch.js";
import { resetTelegramAccountThrottlersForTest } from "./runtime.test-support.js";

beforeEach(() => {
  resetTelegramAccountThrottlersForTest();
});

it("marks typing held back at the gate or in its queue as unsent, unlike Telegram's 429", async () => {
  vi.useFakeTimers();
  const sent: string[] = [];
  const api = new Api("123:typing-unsent", {
    buildUrl: (root, _token, method) => `${root}/${method}`,
    fetch: asTelegramClientFetch(async (input: unknown, init?: { body?: unknown }) => {
      assert(typeof input === "string");
      const method = input.slice(input.lastIndexOf("/") + 1);
      const body = JSON.parse(String(init?.body)) as { text?: string };
      sent.push(method);
      return new Response(
        JSON.stringify(
          method === "editMessageText"
            ? {
                ok: false,
                error_code: 429,
                description: "Too Many Requests: retry after 30",
                parameters: { retry_after: 30 },
              }
            : { ok: true, result: { text: body.text } },
        ),
      );
    }),
  });
  api.config.use(getOrCreateAccountThrottler("typing-unsent").transformer);
  const typing = (thread: number) =>
    api.sendChatAction(-100123, "typing", { message_thread_id: thread });
  const failure = (request: Promise<unknown>) => request.then(String, (error: unknown) => error);
  try {
    await typing(1);
    // Passes the open gate, then waits a second for the chat's next action slot.
    const queued = failure(typing(2));
    const telegramFlood = failure(
      runReplaceableTelegramRequest(() => api.editMessageText(-100222, 9, "preview")),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const atGate = failure(typing(3));
    const errors = await Promise.all([telegramFlood, queued, atGate]);
    const heldBack = {
      description: expect.stringMatching(/\(flood wait active; replaceable update not sent\)$/),
    };
    expect(errors).toMatchObject([
      { error_code: 429, description: "Too Many Requests: retry after 30" },
      heldBack,
      heldBack,
    ]);
    expect(sent).toEqual(["sendChatAction", "editMessageText"]);
  } finally {
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
  }
});
