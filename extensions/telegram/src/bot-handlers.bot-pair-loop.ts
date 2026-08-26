// Telegram bot-pair loop guard.
//
// NOTE: reconstructed 2026-08-26. The original implementation was committed
// empty (0 bytes) at d109b11c and the content was lost on both hosts (verified
// absent from all refs, stashes, and dangling objects on rh-bot and mac-mini).
// This file is rebuilt from its contract: the inbound-pipeline call sites
// (params + the "dropped"/"suppressed" actions), the test-harness hook
// (setTelegramRuntimeConfigForTest), the shared guard
// (src/channels/turn/bot-loop-protection.ts), and the config surface
// (channels.telegram[.accounts.<id>].allowBots / botLoopProtection +
// channels.defaults.botLoopProtection, per the d109b11c docs).
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getTelegramTextParts } from "./bot/body-helpers.js";

export type TelegramBotPairLoopAction = "pass" | "dropped" | "suppressed";

export type EvaluateTelegramBotPairLoopGuardParams = {
  cfg: OpenClawConfig;
  accountId: string;
  botUserId: number;
  msg: Message;
  conversationId: string;
  isChannelPost: boolean;
  getRuntimeConfig: () => OpenClawConfig;
};

type TelegramRuntimeConfigReader = () => OpenClawConfig;

// The harness installs a reader so guard config reads follow the mocked
// runtime config (loadConfig overrides such as setOpenChannelPostConfig).
let runtimeConfigReader: TelegramRuntimeConfigReader | undefined;

/** Test hook: point guard config reads at the harness runtime-config mock. */
export function setTelegramRuntimeConfigForTest(
  reader: TelegramRuntimeConfigReader | undefined,
): void {
  runtimeConfigReader = reader;
}

type BotInteractionShape = {
  allowBots?: boolean | "mentions";
  botLoopProtection?: {
    enabled?: boolean;
    maxEventsPerWindow?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
  };
};

/**
 * Bot-loop protection config layers, narrowest first. `channels.telegram` is
 * `TelegramConfig = TelegramAccountConfig & { accounts?, defaultAccount? }`,
 * so the channel-level and account-level bot-interaction shapes match.
 * The account entry is already merged with channel-level values by
 * mergeTelegramAccountConfig, so reading the resolved account picks up both.
 */
function resolveLoopConfigLayers(
  cfg: OpenClawConfig,
  accountId: string,
): {
  account: BotInteractionShape | undefined;
  channel: BotInteractionShape | undefined;
  defaults: BotInteractionShape["botLoopProtection"] | undefined;
} {
  const telegram = cfg.channels?.telegram;
  const account = telegram?.accounts?.[accountId] as BotInteractionShape | undefined;
  return {
    account,
    channel: telegram as BotInteractionShape | undefined,
    defaults: cfg.channels?.defaults?.botLoopProtection,
  };
}

function botMentionsBot(msg: Message, botUserId: number): boolean {
  const { text, entities } = getTelegramTextParts(msg);
  const idToken = `@${botUserId}`.toLowerCase();
  const nameToken = msg.from?.username ? `@${msg.from.username}`.toLowerCase() : undefined;
  for (const entity of entities) {
    if (entity.type !== "mention" && entity.type !== "bot_command") {
      continue;
    }
    const slice = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (slice.includes(idToken)) {
      return true;
    }
    // Telegram renders bot mentions as @username; resolve via entity.user when present.
    const entityUser = (entity as { user?: { id?: number } }).user;
    if (entityUser?.id === botUserId) {
      return true;
    }
  }
  if (nameToken && text.toLowerCase().includes(nameToken)) {
    return true;
  }
  return text.toLowerCase().includes(idToken);
}

/**
 * Evaluate the shared bot-pair loop guard for one inbound Telegram message.
 *
 * - "pass": not bot traffic, or bot traffic the account admits that is within
 *   budget.
 * - "dropped": bot traffic the account does not admit (allowBots off — the
 *   default — or allowBots "mentions" without a mention of this bot).
 * - "suppressed": the sender/bot pair hit the sliding-window budget and is in
 *   cooldown; the pipeline records the message against the shared reply-chain
 *   store and skips pipeline entry.
 */
export function evaluateTelegramBotPairLoopGuard(params: EvaluateTelegramBotPairLoopGuardParams): {
  action: TelegramBotPairLoopAction;
} {
  const sender = params.msg.from;
  if (!sender?.is_bot) {
    return { action: "pass" };
  }
  const cfg = runtimeConfigReader
    ? runtimeConfigReader()
    : (params.getRuntimeConfig ?? (() => params.cfg))();
  const layers = resolveLoopConfigLayers(cfg, params.accountId);
  const allowBots = layers.account?.allowBots ?? layers.channel?.allowBots;
  if (allowBots !== true && allowBots !== "mentions") {
    logVerbose(
      `telegram[${params.accountId}]: dropping bot message ${params.msg.message_id} (allowBots not enabled)`,
    );
    return { action: "dropped" };
  }
  if (allowBots === "mentions" && !botMentionsBot(params.msg, params.botUserId)) {
    logVerbose(
      `telegram[${params.accountId}]: dropping bot message ${params.msg.message_id} (allowBots=mentions, no mention)`,
    );
    return { action: "dropped" };
  }
  const result = recordChannelBotPairLoopAndCheckSuppression({
    scopeId: params.accountId,
    conversationId: params.conversationId,
    senderId: String(sender.id),
    receiverId: String(params.botUserId),
    eventId: `tg-${params.msg.message_id}`,
    config: mergePairLoopGuardConfig(
      layers.account?.botLoopProtection,
      layers.channel?.botLoopProtection,
    ),
    defaultsConfig: layers.defaults,
    defaultEnabled: true,
    nowMs: typeof params.msg.date === "number" ? params.msg.date * 1000 : undefined,
  });
  if (result.suppressed) {
    logVerbose(
      `telegram[${params.accountId}]: bot-pair loop suppressed ${sender.id} <-> ${params.botUserId} in ${params.conversationId} for ${Math.max(0, Math.ceil((result.cooldownUntilMs - Date.now()) / 1000))}s`,
    );
    return { action: "suppressed" };
  }
  return { action: "pass" };
}
