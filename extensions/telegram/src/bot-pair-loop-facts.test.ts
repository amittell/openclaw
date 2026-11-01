// Telegram tests cover bot-pair loop guard fact building.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildTelegramBotPairLoopFacts } from "./bot-pair-loop-facts.js";

// Which messages are RECORDED against the shared (account, chat, bot pair) guard.
// The counting and suppression half is the shared guard's own contract and is covered by
// src/plugin-sdk/pair-loop-guard-runtime.test.ts; what is Telegram's to get right is that
// bot-to-bot traffic is offered to it at all, which is what this line never did.
const BOT_USER_ID = 4242;

const cfg = (telegram: Record<string, unknown> = {}, defaults?: Record<string, unknown>) =>
  ({
    channels: {
      telegram,
      ...(defaults ? { defaults } : {}),
    },
  }) as unknown as OpenClawConfig;

const message = (
  from: Partial<NonNullable<Message["from"]>> | undefined,
  chatId = -100123,
): Message =>
  ({
    message_id: 77,
    date: 1_700_000_000,
    chat: { id: chatId, type: "supergroup" },
    ...(from ? { from } : {}),
  }) as unknown as Message;

describe("buildTelegramBotPairLoopFacts", () => {
  it("records nothing for a human sender", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      msg: message({ id: 9, is_bot: false, first_name: "A" }),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toBeUndefined();
  });

  it("records nothing when the sender is this bot itself", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      msg: message({ id: BOT_USER_ID, is_bot: true, first_name: "Me" }),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toBeUndefined();
  });

  // A message sent ON BEHALF OF a chat carries `sender_chat`, and its `from` is a
  // backward-compatibility placeholder with `is_bot: true` rather than the author. Counting
  // those spends the pair budget on traffic no bot wrote (upstream #151924).
  const onBehalfOf = (
    from: Partial<NonNullable<Message["from"]>>,
    senderChat: Record<string, unknown> | undefined,
    chat: Record<string, unknown> = { id: -100123, type: "supergroup" },
  ): Message =>
    ({
      message_id: 77,
      date: 1_700_000_000,
      chat,
      from,
      ...(senderChat ? { sender_chat: senderChat } : {}),
    }) as unknown as Message;

  it("records nothing for an anonymous admin posting as the group", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      // GroupAnonymousBot: is_bot, but the author is the group, not a bot.
      msg: onBehalfOf(
        { id: 1087968824, is_bot: true, first_name: "Group" },
        {
          id: -100123,
          type: "supergroup",
        },
      ),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toBeUndefined();
  });

  it("records nothing for a linked-channel forward into the discussion group", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      msg: onBehalfOf(
        { id: 777000, is_bot: true, first_name: "Telegram" },
        {
          id: -100999,
          type: "channel",
        },
      ),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toBeUndefined();
  });

  it("still records a channel post that carries a real bot author", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      msg: onBehalfOf(
        { id: 99, is_bot: true, first_name: "Other" },
        { id: -100555, type: "channel" },
        { id: -100555, type: "channel" },
      ),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toMatchObject({ senderId: "99", receiverId: String(BOT_USER_ID) });
  });

  it("records another bot as a pair against this bot, in this chat", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "requesty",
      msg: message({ id: 99, is_bot: true, first_name: "Other" }),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toMatchObject({
      scopeId: "requesty",
      conversationId: "-100123",
      senderId: "99",
      receiverId: String(BOT_USER_ID),
      eventId: "77",
      defaultEnabled: true,
      nowMs: 1_700_000_000_000,
    });
  });

  it("carries the account's budget and the channel defaults through to the guard", () => {
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(
        { botLoopProtection: { maxEventsPerWindow: 3 } },
        { botLoopProtection: { cooldownSeconds: 90 } },
      ),
      accountId: "default",
      msg: message({ id: 99, is_bot: true, first_name: "Other" }),
      botUserId: BOT_USER_ID,
    });
    expect(facts?.config).toMatchObject({ maxEventsPerWindow: 3 });
    expect(facts?.defaultsConfig).toMatchObject({ cooldownSeconds: 90 });
  });

  it("records a channel post, whose synthetic sender is a bot", () => {
    // normalizeChannelPostMessage stamps is_bot on the synthetic sender, so a pair of bots
    // posting into one channel is exactly the loop this bounds.
    const facts = buildTelegramBotPairLoopFacts({
      cfg: cfg(),
      accountId: "default",
      msg: message({ id: -100555, is_bot: true, first_name: "Channel" }),
      botUserId: BOT_USER_ID,
    });
    expect(facts).toMatchObject({ senderId: "-100555", receiverId: String(BOT_USER_ID) });
  });
});
