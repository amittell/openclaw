import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
import { mergeTelegramAccountConfig } from "./account-config.js";

/**
 * Facts for the SHARED channel bot-pair loop guard, or undefined when this message is not
 * bot-to-bot traffic and so records nothing.
 *
 * Split out of the inbound pipeline deliberately: inside the handler closure the decision
 * was unreachable from a test, and the pipeline's own test file does not construct handlers.
 * As a pure function the "which messages are recorded" rule is directly testable, and the
 * counting/suppression half stays covered by the guard's own tests.
 */
/**
 * Whether this message is another bot's, i.e. a loop candidate at all. Exported so the
 * inbound pipeline can answer it BEFORE reading the runtime config: every human message
 * takes this path, and reading config first added a config read per inbound message.
 */
export function isTelegramBotPairLoopCandidate(msg: Message, botUserId: number): boolean {
  const sender = msg.from;
  if (sender?.is_bot !== true || sender.id === botUserId) {
    return false;
  }
  // A message sent ON BEHALF OF a chat carries `sender_chat`, and its `from` is then a
  // backward-compatibility placeholder rather than the author: anonymous group admins,
  // linked-channel forwards and unattributed channel posts all arrive with `is_bot: true`
  // under a placeholder id. Counting those spends the pair budget on traffic no bot wrote,
  // and can suppress a human posting as the group. A channel post that genuinely carries a
  // bot `from` still counts. Ported from upstream #151924's `isOtherBotAuthor`, which is
  // the same rule this fork's guard needs; the wiring here stays the fork's own.
  const senderChat = msg.sender_chat;
  if (sender.id === senderChat?.id || (msg.chat.type !== "private" && sender.id === msg.chat.id)) {
    return false;
  }
  return !senderChat || (senderChat.type === "channel" && senderChat.id === msg.chat.id);
}

export function buildTelegramBotPairLoopFacts(params: {
  cfg: OpenClawConfig;
  accountId: string;
  msg: Message;
  botUserId: number;
}): ChannelBotLoopProtectionFacts | undefined {
  const sender = params.msg.from;
  // Only another bot's message is a loop candidate. Our own id is already handled upstream,
  // and re-checking here keeps this function correct on its own terms.
  if (!sender || !isTelegramBotPairLoopCandidate(params.msg, params.botUserId)) {
    return undefined;
  }
  const accountConfig = mergeTelegramAccountConfig(params.cfg, params.accountId);
  return {
    scopeId: params.accountId,
    conversationId: String(params.msg.chat.id),
    senderId: String(sender.id),
    receiverId: String(params.botUserId),
    eventId: params.msg.message_id != null ? String(params.msg.message_id) : undefined,
    config: accountConfig.botLoopProtection,
    defaultsConfig: params.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
    nowMs: typeof params.msg.date === "number" ? params.msg.date * 1000 : undefined,
  };
}
