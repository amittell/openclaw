// Telegram tests cover the bot-pair loop guard wiring in the inbound pipeline: another bot's
// group messages and channel posts are counted against the shared guard before dispatch.
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

const { getLoadConfigMock, getOnHandler, replySpy, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");

const OTHER_BOT = { id: 98_765, is_bot: true, first_name: "relaybot", username: "relay_bot" };
const POSTS = 5;
const DATE = 1_736_380_800;
// The guard is process-wide and keyed by conversation, so every case gets its own chat.
let nextChatId = -100_555_000_000;

async function registerHandlers(chatId: number, enabled: boolean) {
  getLoadConfigMock().mockReturnValue({
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: { [String(chatId)]: { enabled: true, requireMention: false } },
        botLoopProtection: {
          enabled,
          maxEventsPerWindow: 2,
          windowSeconds: 60,
          cooldownSeconds: 60,
        },
      },
    },
  });
  await createTelegramBotCore({
    token: "tok",
    botInfo: telegramBotInfoForTest,
    telegramDeps: telegramBotDepsForTest,
  });
}

async function sendGroupMessagesFromOtherBot(chatId: number) {
  const handler = getOnHandler("message");
  for (let index = 0; index < POSTS; index++) {
    await handler({
      update: { update_id: 7_000 + index },
      message: {
        chat: { id: chatId, type: "supergroup", title: "Bot Pair Group" },
        from: OTHER_BOT,
        message_id: 100 + index,
        date: DATE + index,
        text: `relay ${index}`,
      },
      me: telegramBotInfoForTest,
      getFile: async () => ({}),
    });
  }
}

async function sendChannelPostsFromOtherBot(chatId: number) {
  const handler = getOnHandler("channel_post");
  for (let index = 0; index < POSTS; index++) {
    await handler({
      update: { update_id: 8_000 + index },
      channelPost: {
        chat: { id: chatId, type: "channel", title: "Bot Pair Channel" },
        sender_chat: { id: chatId, type: "channel", title: "Bot Pair Channel" },
        from: OTHER_BOT,
        message_id: 200 + index,
        date: DATE + index,
        text: `relay ${index}`,
      },
      me: telegramBotInfoForTest,
      getFile: async () => ({}),
    });
  }
}

describe("Telegram bot-pair loop guard wiring", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "telegram-bot-pair-loop" });
  });
  afterEach(async () => {
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it.each([
    { enabled: true, replies: 2 },
    { enabled: false, replies: POSTS },
  ])(
    "replies to $replies of five group messages from another bot (guard enabled: $enabled, budget 2)",
    async ({ enabled, replies }) => {
      const chatId = nextChatId--;
      await registerHandlers(chatId, enabled);
      await sendGroupMessagesFromOtherBot(chatId);
      expect(replySpy).toHaveBeenCalledTimes(replies);
    },
  );

  it.each([
    { enabled: true, replies: 2 },
    { enabled: false, replies: POSTS },
  ])(
    "replies to $replies of five channel posts from another bot (guard enabled: $enabled, budget 2)",
    async ({ enabled, replies }) => {
      const chatId = nextChatId--;
      await registerHandlers(chatId, enabled);
      await sendChannelPostsFromOtherBot(chatId);
      expect(replySpy).toHaveBeenCalledTimes(replies);
    },
  );
});
