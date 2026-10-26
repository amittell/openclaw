import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/channel-inbound";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramInboundProcessing } from "./bot-handlers.inbound-processing.js";
import {
  buildSyntheticContext,
  promptContextBoundaryOptions,
} from "./bot-handlers.message-context.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type {
  RegisterTelegramHandlerParams,
  TelegramInboundDisposition,
  TelegramInboundPipeline,
} from "./bot-handlers.types.js";
import {
  buildTelegramBotPairLoopFacts,
  isTelegramBotPairLoopCandidate,
} from "./bot-pair-loop-facts.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  resolveTelegramBotHasTopicsEnabled,
  resolveTelegramForumFlag,
  withResolvedTelegramForumFlag,
  TelegramPairingStoreReadError,
} from "./bot/helpers.js";
import type { TelegramGetChat } from "./bot/types.js";
import { emitTelegramLiveLocationMessageHook } from "./location-message-hook.js";

export function createTelegramInboundPipeline({
  params: handlerParams,
  message: messageRuntime,
  authorization: authorizationRuntime,
}: {
  params: RegisterTelegramHandlerParams;
  message: TelegramMessagePipeline;
  authorization: TelegramHandlerAuthorization;
}): TelegramInboundPipeline {
  const { accountId, bot, opts, runtime, shouldSkipUpdate, telegramDeps } = handlerParams;
  const {
    releaseDispatchDedupeClaims,
    claimMessageDispatchDedupe,
    resolveTelegramSessionState,
    resolvePromptContextAmbientWatermark,
    recordMessageForReplyChain,
  } = messageRuntime;
  const { authorizeInboundMessage } = authorizationRuntime;
  const { processInboundMessage } = createTelegramInboundProcessing({
    params: handlerParams,
    message: messageRuntime,
  });
  const getChat: TelegramGetChat = bot.api.getChat.bind(bot.api);
  const resolveForumFlag = (msg: Message, isGroup: boolean) =>
    resolveTelegramForumFlag({
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isGroup,
      isForum: msg.chat.is_forum,
      isTopicMessage: msg.is_topic_message,
      getChat,
    });
  const resolveBotUserId = (ctx: { me?: { id?: number } }): number => {
    const botUserId = ctx.me?.id ?? opts.botInfo?.id;
    if (botUserId == null) {
      throw new Error("Telegram bot identity is unavailable");
    }
    return botUserId;
  };
  // Bot-to-bot loop protection. Telegram is the only mainstream channel that supplied no
  // botLoopProtection facts, so the shared drop in src/channels/turn/execution.ts could
  // never fire for it; Discord does the same thing in its own preflight. This records the
  // (account, chat, bot pair) against the SHARED guard rather than a per-channel one -
  // the fork's extensions/telegram bot-pair-loop file was superseded by the channel-generic
  // guard, and carrying it would install a second guard inside a channel plugin.
  //
  // Only a message whose sender is another bot is recorded. Channel posts carry a synthetic
  // is_bot sender, which is deliberate: a pair of bots posting into a channel is exactly the
  // loop this bounds. Suppression is per pair and time-boxed by the configured cooldown, so
  // a one-shot bot reply under the budget is unaffected.
  const isSuppressedBotPairLoop = (msg: Message, botUserId: number): boolean => {
    // Human traffic is the common case: decide it before touching the runtime config.
    if (!isTelegramBotPairLoopCandidate(msg, botUserId)) {
      return false;
    }
    const cfg = telegramDeps.getRuntimeConfig();
    const facts = buildTelegramBotPairLoopFacts({ cfg, accountId, msg, botUserId });
    if (!facts) {
      return false;
    }
    const result = recordChannelBotPairLoopAndCheckSuppression(facts);
    if (!result.suppressed) {
      return false;
    }
    logVerbose(
      `telegram: bot-to-bot loop suppressed for pair ${facts.senderId}->${facts.receiverId} in ${facts.conversationId} for ${Math.max(0, Math.ceil((result.cooldownUntilMs - Date.now()) / 1000))}s`,
    );
    return true;
  };
  const normalizeChannelPostMessage = (post: Message): Message => {
    const senderChat = post.sender_chat ?? post.chat;
    const syntheticFrom = {
      id: senderChat.id,
      is_bot: true as const,
      first_name: senderChat.title || "Channel",
      ...(senderChat.username !== undefined ? { username: senderChat.username } : {}),
    };
    return {
      ...post,
      from: post.from ?? syntheticFrom,
      chat: {
        ...post.chat,
        type: "supergroup" as const,
      },
    } as Message;
  };
  const handleMessage = async (
    ctx: Context,
    kind: "message" | "channel_post",
  ): Promise<TelegramInboundDisposition> => {
    const isChannelPost = kind === "channel_post";
    const msg = isChannelPost ? ctx.channelPost : ctx.message;
    if (!msg) {
      return { kind: "ignored" };
    }
    const isGroup = isChannelPost || msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = isChannelPost ? false : await resolveForumFlag(msg, isGroup);
    const normalizedMsg = isChannelPost
      ? normalizeChannelPostMessage(msg)
      : withResolvedTelegramForumFlag(msg, isForum);
    const botUserId = resolveBotUserId(ctx);
    // Bot-authored message updates can be echoed back by Telegram. Channel-originated posts
    // remain eligible even when their sender is this bot.
    if (!isChannelPost && normalizedMsg.from?.id != null && normalizedMsg.from.id === botUserId) {
      return { kind: "ignored" };
    }
    // Fork: bot-to-bot loop guard, on both message and channel_post (the synthetic
    // channel-post sender is deliberately eligible; see isSuppressedBotPairLoop).
    if (isSuppressedBotPairLoop(normalizedMsg, botUserId)) {
      return { kind: "ignored" };
    }
    const chatId = normalizedMsg.chat.id;
    const syntheticContext = buildSyntheticContext(ctx, normalizedMsg);
    const senderId =
      isChannelPost && msg.sender_chat?.id != null
        ? String(msg.sender_chat.id)
        : msg.from?.id != null
          ? String(msg.from.id)
          : "";
    let dispatchDedupeClaims: ChannelReplayClaimHandle[] = [];
    try {
      if (shouldSkipUpdate(ctx)) {
        return { kind: "ignored" };
      }
      const gate = await authorizeInboundMessage({
        msg: normalizedMsg,
        chatId,
        isGroup,
        isForum,
        senderId,
        requireConfiguredGroup: isChannelPost,
        dmAccess: "challenge",
      });
      if (!gate.allowed) {
        return { kind: "ignored" };
      }
      const { effectiveDmAllow } = gate;
      const {
        dmPolicy,
        resolvedThreadId,
        storeAllowFrom,
        groupConfig,
        topicConfig,
        effectiveGroupAllow,
        threadSpec,
      } = gate.context;

      const sessionState = await resolveTelegramSessionState({
        chatId,
        isGroup,
        threadSpec,
        botHasTopicsEnabled: resolveTelegramBotHasTopicsEnabled(syntheticContext.me),
        senderId,
        runtimeCfg: gate.context.cfg,
      });
      const promptContextMinTimestampMs = asFiniteNumber(
        sessionState.sessionEntry?.sessionStartedAt,
      );
      const promptContextAmbientWatermark = resolvePromptContextAmbientWatermark({
        chatId,
        isGroup,
        resolvedThreadId,
        sessionKey: sessionState.sessionKey,
        storePath: sessionState.storePath,
      });

      const dispatchDedupe = await claimMessageDispatchDedupe(normalizedMsg, botUserId);
      if (!dispatchDedupe.process) {
        return { kind: "ignored" };
      }
      dispatchDedupeClaims = dispatchDedupe.claims;
      await recordMessageForReplyChain(normalizedMsg, gate.context.threadSpec, botUserId);
      return await processInboundMessage({
        authorizationCfg: gate.context.cfg,
        ctx: syntheticContext,
        msg: normalizedMsg,
        chatId,
        isGroup,
        threadSpec,
        dmPolicy,
        storeAllowFrom,
        senderId,
        effectiveGroupAllow,
        effectiveDmAllow,
        channelIngressResolver: gate.resolveChannelIngress,
        groupConfig: isGroup ? (groupConfig as TelegramGroupConfig | undefined) : undefined,
        topicConfig,
        sendOversizeWarning: !isChannelPost,
        oversizeLogMessage: isChannelPost
          ? "channel post media exceeds size limit"
          : "media exceeds size limit",
        dispatchDedupeClaims,
        ...promptContextBoundaryOptions(promptContextMinTimestampMs, promptContextAmbientWatermark),
      });
    } catch (err) {
      releaseDispatchDedupeClaims(dispatchDedupeClaims, err);
      const errorMessage = isChannelPost ? "channel_post handler failed" : "handler failed";
      runtime.error?.(danger(`${errorMessage}: ${String(err)}`));
      const spooledReplay = isTelegramSpooledReplayUpdate(syntheticContext.update);
      if (err instanceof TelegramPairingStoreReadError || spooledReplay) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        // Spooled replays are durably retried; live updates get one apology
        // because they are acked without replay.
        if (spooledReplay) {
          return { kind: "ignored" };
        }
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime,
          fn: () =>
            bot.api.sendMessage(
              chatId,
              "⚠️ Couldn't process this message, please try again in a moment.",
              {
                reply_parameters: {
                  message_id: normalizedMsg.message_id,
                  allow_sending_without_reply: true,
                },
              },
            ),
        }).catch(() => {});
      }
      return { kind: "ignored" };
    }
  };

  const handleEditedMessage = async (
    ctx: Context,
    kind: "edited_message" | "edited_channel_post",
  ): Promise<TelegramInboundDisposition> => {
    const isChannelPost = kind === "edited_channel_post";
    const original = isChannelPost ? ctx.editedChannelPost : ctx.editedMessage;
    if (!original) {
      return { kind: "ignored" };
    }
    const msg = isChannelPost ? normalizeChannelPostMessage(original) : original;
    const botUserId = resolveBotUserId(ctx);
    const updateId = ctx.update?.update_id;
    if (shouldSkipUpdate(ctx)) {
      return { kind: "recorded" };
    }
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
    const isForum = await resolveForumFlag(msg, isGroup);
    const normalizedMsg = withResolvedTelegramForumFlag(msg, isForum);
    const gate = await authorizeInboundMessage({
      msg: normalizedMsg,
      chatId: normalizedMsg.chat.id,
      isGroup,
      isForum,
      senderId: normalizedMsg.from?.id != null ? String(normalizedMsg.from.id) : "",
      requireConfiguredGroup: isChannelPost,
      dmAccess: "silent",
    });
    if (gate.allowed) {
      await recordMessageForReplyChain(normalizedMsg, gate.context.threadSpec, botUserId);
      if (typeof updateId === "number") {
        emitTelegramLiveLocationMessageHook({
          accountId,
          msg: normalizedMsg,
          updateId,
          updateKind: kind,
          isForum,
        });
      }
    }
    return { kind: "recorded" };
  };

  return {
    handle: async (ctx) => {
      if (ctx.message) {
        return await handleMessage(ctx, "message");
      }
      if (ctx.editedMessage) {
        return await handleEditedMessage(ctx, "edited_message");
      }
      if (ctx.channelPost) {
        return await handleMessage(ctx, "channel_post");
      }
      if (ctx.editedChannelPost) {
        return await handleEditedMessage(ctx, "edited_channel_post");
      }
      return { kind: "ignored" };
    },
  };
}

export function registerTelegramInboundHandlers({
  bot,
  pipeline,
}: {
  bot: RegisterTelegramHandlerParams["bot"];
  pipeline: Pick<TelegramInboundPipeline, "handle">;
}): void {
  bot.on(["message", "edited_message", "channel_post", "edited_channel_post"], pipeline.handle);
}
