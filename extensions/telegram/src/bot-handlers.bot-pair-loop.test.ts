// Unit tests for the Telegram bot-pair loop guard (reconstructed 2026-08-26).
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  evaluateTelegramBotPairLoopGuard,
  setTelegramRuntimeConfigForTest,
} from "./bot-handlers.bot-pair-loop.js";

// The guard is a module-level shared in-memory store (like discord/feishu use);
// isolate the test run by stubbing it with a per-test instance.
const recordMock = vi.fn();
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    recordChannelBotPairLoopAndCheckSuppression: (...args: unknown[]) =>
      recordMock(...(args as [never])),
  };
});

const BOT_USER_ID = 900000001;

function makeBotMessage(conversationId: string, overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1000,
    date: 1_700_000_000,
    text: "ping",
    from: { id: 900000002, is_bot: true, first_name: "OtherBot" },
    chat: { id: Number(conversationId.replace(/\D/g, "")) || -100_000_000_001, type: "group" },
    ...overrides,
  } as Message;
}

function makeUserMessage(): Message {
  return {
    message_id: 2000,
    date: 1_700_000_100,
    text: "hello",
    from: { id: 42, is_bot: false, first_name: "Human" },
    chat: { id: -100_000_000_001, type: "group" },
  } as Message;
}

function makeConfig(telegram: {
  allowBots?: boolean | "mentions";
  botLoopProtection?: {
    enabled?: boolean;
    maxEventsPerWindow?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
  };
  accounts?: Record<string, { allowBots?: boolean | "mentions" }>;
}): OpenClawConfig {
  return { channels: { telegram: telegram as never } } as OpenClawConfig;
}

function evaluate(
  cfg: OpenClawConfig,
  msg: Message,
  conversationId = "conv-a",
  isChannelPost = false,
) {
  return evaluateTelegramBotPairLoopGuard({
    cfg,
    accountId: "default",
    botUserId: BOT_USER_ID,
    msg,
    conversationId,
    isChannelPost,
    getRuntimeConfig: () => cfg,
  });
}

describe("evaluateTelegramBotPairLoopGuard", () => {
  beforeEach(() => {
    setTelegramRuntimeConfigForTest(undefined);
    recordMock.mockReset();
    recordMock.mockReturnValue({ suppressed: false });
  });

  it("passes non-bot inbound messages untouched and skips the guard", () => {
    expect(evaluate(makeConfig({ allowBots: true }), makeUserMessage()).action).toBe("pass");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("drops bot messages when allowBots is unset (default off)", () => {
    expect(evaluate(makeConfig({}), makeBotMessage("conv-b1")).action).toBe("dropped");
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("drops bot messages when allowBots is false", () => {
    expect(evaluate(makeConfig({ allowBots: false }), makeBotMessage("conv-b2")).action).toBe(
      "dropped",
    );
  });

  it("passes an admitted bot message within budget and records the pair", () => {
    expect(
      evaluate(makeConfig({ allowBots: true }), makeBotMessage("conv-c1"), "conv-c1").action,
    ).toBe("pass");
    expect(recordMock).toHaveBeenCalledTimes(1);
    const facts = recordMock.mock.calls[0][0] as Record<string, unknown>;
    expect(facts.scopeId).toBe("default");
    expect(facts.conversationId).toBe("conv-c1");
    expect(facts.receiverId).toBe(String(BOT_USER_ID));
    expect(facts.eventId).toMatch(/^tg-/);
    expect(facts.defaultEnabled).toBe(true);
  });

  it("respects account-level allowBots over channel-level", () => {
    const cfg = makeConfig({
      allowBots: true,
      accounts: { default: { allowBots: false } },
    });
    expect(evaluate(cfg, makeBotMessage("conv-d1")).action).toBe("dropped");
  });

  it("drops unmentioned bot messages when allowBots is 'mentions'", () => {
    const cfg = makeConfig({ allowBots: "mentions" });
    expect(evaluate(cfg, makeBotMessage("conv-e1", { text: "just chatting" })).action).toBe(
      "dropped",
    );
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("passes bot messages that mention the bot by user id when allowBots is 'mentions'", () => {
    const cfg = makeConfig({ allowBots: "mentions" });
    const mentioned = makeBotMessage("conv-e2", { text: `hey @${BOT_USER_ID} respond` });
    expect(evaluate(cfg, mentioned).action).toBe("pass");
  });

  it("suppresses the pair once the shared guard reports cooldown", () => {
    const cfg = makeConfig({
      allowBots: true,
      botLoopProtection: { maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60 },
    });
    recordMock
      .mockReturnValueOnce({ suppressed: false })
      .mockReturnValueOnce({ suppressed: false })
      .mockReturnValueOnce({ suppressed: true, cooldownUntilMs: Date.now() + 60_000 });
    expect(evaluate(cfg, makeBotMessage("conv-f1", { message_id: 1 }), "conv-f1").action).toBe(
      "pass",
    );
    expect(evaluate(cfg, makeBotMessage("conv-f1", { message_id: 2 }), "conv-f1").action).toBe(
      "pass",
    );
    expect(evaluate(cfg, makeBotMessage("conv-f1", { message_id: 3 }), "conv-f1").action).toBe(
      "suppressed",
    );
    // The suppressed pair carries its loop-protection config into the guard facts.
    const lastFacts = recordMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastFacts.config).toEqual({
      maxEventsPerWindow: 2,
      windowSeconds: 60,
      cooldownSeconds: 60,
    });
  });

  it("keeps suppressing while the shared guard is in cooldown", () => {
    const cfg = makeConfig({ allowBots: true });
    recordMock.mockReturnValue({ suppressed: true, cooldownUntilMs: Date.now() + 60_000 });
    expect(evaluate(cfg, makeBotMessage("conv-g1", { message_id: 1 })).action).toBe("suppressed");
    expect(evaluate(cfg, makeBotMessage("conv-g1", { message_id: 2 })).action).toBe("suppressed");
  });

  it("passes channel posts through the guard for budget accounting (admitted)", () => {
    const cfg = makeConfig({ allowBots: true });
    const post = makeBotMessage("conv-h1", { message_id: 5000, text: "channel post" });
    expect(evaluate(cfg, post, "conv-h1", true).action).toBe("pass");
  });

  it("uses the harness runtime-config reader when installed", () => {
    const readerCfg = makeConfig({ allowBots: false });
    setTelegramRuntimeConfigForTest(() => readerCfg);
    // The pipeline passes allowBots true, but the harness-installed reader wins.
    expect(evaluate(makeConfig({ allowBots: true }), makeBotMessage("conv-i1")).action).toBe(
      "dropped",
    );
  });
});
