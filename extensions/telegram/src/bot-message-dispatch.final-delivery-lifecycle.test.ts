import type { Message } from "grammy/types";
import {
  createAcceptedChannelDeliveryResult,
  createChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { dispatchReplyWithBufferedBlockDispatcher as dispatchThroughSharedOwner } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  createBot,
  createContext,
  createDirectSessionPayload,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitToolStart,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { DispatchReplyWithBufferedBlockDispatcherArgs } from "./bot-message-dispatch.test-harness.js";
import {
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type * as DeliveryRepliesModule from "./bot/delivery.replies.js";
import type { TelegramContext } from "./bot/types.js";
import type * as DraftStreamModule from "./draft-stream.js";
import type * as SendEditModule from "./send-edit.js";

function retiredPluginError() {
  return Object.assign(
    new Error("Plugin telegram was reloaded or disabled; use its current tools."),
    { name: "PluginInstanceUnavailableError" },
  );
}

async function setupObservedProgressTransport() {
  const [draft, delivery, edit] = await Promise.all([
    vi.importActual<typeof DraftStreamModule>("./draft-stream.js"),
    vi.importActual<typeof DeliveryRepliesModule>("./bot/delivery.replies.js"),
    vi.importActual<typeof SendEditModule>("./send-edit.js"),
  ]);
  createTelegramDraftStream.mockImplementation(draft.createTelegramDraftStream);
  deliverReplies.mockImplementation(delivery.deliverStructuredReplies);
  editMessageTelegram.mockImplementation(edit.editMessageTelegram);
  const bot = createBot();
  const messages = new Map<number, string>();
  let nextMessageId = 1000;
  const sendMessage = vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text) => {
    const message_id = ++nextMessageId;
    messages.set(message_id, text);
    return {
      message_id,
      date: 0,
      chat: { id: Number(chatId), type: "private", first_name: "Test" },
      text,
    };
  });
  const editMessageText = vi
    .spyOn(bot.api, "editMessageText")
    .mockImplementation(async (_chatId, messageId, text) => {
      if (typeof text !== "string") {
        throw new Error("This transport fixture expects legacy Telegram text.");
      }
      if (!messages.has(messageId)) {
        throw new Error("Bad Request: message to edit not found");
      }
      messages.set(messageId, text);
      return true;
    });
  const deleteMessage = vi
    .spyOn(bot.api, "deleteMessage")
    .mockImplementation(async (_chatId, messageId) => {
      messages.delete(messageId);
      return true;
    });
  return {
    bot,
    messages,
    sendMessage,
    editMessageText,
    deleteMessage,
    deliver: delivery.deliverStructuredReplies,
  };
}

function progressContext(
  statusReactionController = createStatusReactionController(),
  messageId = 456,
) {
  return createContext({
    ctxPayload: { ...createDirectSessionPayload(), MessageSid: String(messageId) },
    threadSpec: { id: undefined, scope: "none" },
    replyThreadId: undefined,
    msg: {
      chat: { id: 123, type: "private", first_name: "Test" },
      message_id: messageId,
      date: 0,
    },
    statusReactionController,
  });
}

const progressConfig = {
  streaming: { mode: "progress", progress: { toolProgress: true } },
} as const;

function createLoggedRuntime() {
  const log = vi.fn<(...args: unknown[]) => void>();
  return {
    runtime: {
      log,
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    },
    outcomeLines: () =>
      log.mock.calls
        .map((args) => args.join(" "))
        .filter((line) => line.startsWith("telegram final delivery outcome=")),
  };
}

describeTelegramDispatch("dispatchTelegramMessage final-delivery-lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { failure: "retired instance", mode: "progress" },
    { failure: "definite no-send", mode: "progress" },
    { failure: "retired instance", mode: "off" },
    { failure: "rejected tail", mode: "off" },
  ] as const)(
    "preserves accepted content and reports $failure with streaming $mode",
    async ({ failure, mode }) => {
      const { bot, messages, sendMessage, deleteMessage } = await setupObservedProgressTransport();
      const failedStatus = createStatusReactionController();
      const prefix = "Accepted final prefix";
      const tail = "Rejected final tail";
      const partial = failure === "rejected tail";
      const finalText = partial
        ? `${prefix}\n\n${tail}`
        : "The answer whose delivery cannot be confirmed";
      if (partial) {
        deliverInboundReplyWithMessageSendContext.mockImplementationOnce(async () => {
          const accepted = await bot.api.sendMessage(123, prefix);
          sendMessage.mockRejectedValueOnce(new Error("final tail rejected"));
          try {
            await bot.api.sendMessage(123, tail);
          } catch (error) {
            throw createChannelPartialDeliveryError(
              error,
              createAcceptedChannelDeliveryResult({
                results: [{ messageId: String(accepted.message_id) }],
                content: prefix,
              }),
            );
          }
          throw new Error("Expected the final tail send to reject");
        });
      } else if (failure === "retired instance") {
        deliverInboundReplyWithMessageSendContext.mockRejectedValueOnce(retiredPluginError());
      } else {
        // A confirmed non-send may be retried without rerunning the model.
        deliverInboundReplyWithMessageSendContext.mockResolvedValue({ status: "handled_no_send" });
      }
      const replyResolver = vi.fn<
        NonNullable<DispatchReplyWithBufferedBlockDispatcherArgs["replyResolver"]>
      >(async (_ctx, options) => {
        if (mode === "progress") {
          await emitToolStart(options, { name: "exec", phase: "start", toolCallId: "failed-1" });
          expect([...messages.values()]).toEqual([expect.stringContaining("Exec")]);
        }
        return { text: finalText };
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
        dispatchThroughSharedOwner({ ...params, replyResolver }),
      );
      const telegramCfg = mode === "progress" ? progressConfig : { streaming: { mode } };
      const result = await dispatchWithContext({
        bot,
        context: progressContext(failedStatus),
        streamMode: mode,
        telegramCfg,
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.values()]).toEqual([
        ...(partial ? [prefix] : []),
        expect.stringMatching(mode === "progress" ? /Exec|chat history/i : /chat history/i),
      ]);
      expect(sendMessage.mock.calls.some(([, text]) => text === finalText)).toBe(false);
      expect(replyResolver).toHaveBeenCalledOnce();
      expect(failedStatus.setError).toHaveBeenCalledOnce();
      expect(failedStatus.setDone).not.toHaveBeenCalled();
      if (failure !== "definite no-send") {
        expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledOnce();
        expect(result).toEqual({ kind: "completed" });
      }
      if (mode === "progress") {
        expect(deliverReplies).not.toHaveBeenCalled();
        expect(deleteMessage).not.toHaveBeenCalled();
      } else if (!partial) {
        expect(sendMessage).toHaveBeenCalledOnce();
      }
      if (partial) {
        expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
          prefix,
          tail,
          expect.stringMatching(/chat history/i),
        ]);
        return;
      }

      const retainedFailure = [...messages.entries()];
      const nextStatus = createStatusReactionController();
      if (mode === "progress") {
        deliverInboundReplyWithMessageSendContext.mockResolvedValue({
          status: "unsupported",
          reason: "missing_outbound_handler",
        });
      }
      const nextText = "The next turn succeeds";
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
        dispatchThroughSharedOwner({
          ...params,
          replyResolver: async (_ctx, options) => {
            if (mode === "progress") {
              await emitToolStart(options, { name: "read", phase: "start", toolCallId: "next-1" });
            }
            return { text: nextText };
          },
        }),
      );
      await dispatchWithContext({
        bot,
        context: progressContext(nextStatus, 457),
        streamMode: mode,
        telegramCfg,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect([...messages.entries()]).toEqual([...retainedFailure, [expect.any(Number), nextText]]);
      expect(sendMessage.mock.calls.filter(([, text]) => text === nextText)).toHaveLength(1);
      if (mode === "off") {
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(replyResolver).toHaveBeenCalledOnce();
      }
      expect(nextStatus.setDone).toHaveBeenCalledOnce();
      expect(nextStatus.setError).not.toHaveBeenCalled();
      expect(failedStatus.setDone).not.toHaveBeenCalled();
    },
  );

  it("logs a final answer finalized in the preview as one outcome line", async () => {
    const { bot, messages, sendMessage, editMessageText } = await setupObservedProgressTransport();
    const { runtime, outcomeLines } = createLoggedRuntime();
    const preview = "Answer in progress while the model keeps writing";
    const final = "Complete answer edited into the preview";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: preview });
      await createTelegramDraftStream.mock.results[0]?.value?.flush();
      expect([...messages.values()]).toEqual([preview]);
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: final }),
      });
    });

    const result = await dispatchWithContext({
      bot,
      context: progressContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
      runtime,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "completed" });
    expect([...messages.values()]).toEqual([final]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).toHaveBeenCalled();
    expect(outcomeLines()).toEqual([
      `telegram final delivery outcome=preview-finalized chat=123 message=${[...messages.keys()][0]}`,
    ]);
  });

  it("logs a final cancelled by a sending hook as a skipped outcome", async () => {
    const { bot, messages } = await setupObservedProgressTransport();
    const { runtime, outcomeLines } = createLoggedRuntime();
    deliverInboundReplyWithMessageSendContext.mockResolvedValueOnce({
      status: "handled_no_send",
      reason: "no_visible_result",
      delivery: { suppression: { reason: "cancelled_by_message_sending_hook" } },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
      dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: "A final the sending hook cancels" }),
      }),
    );

    await dispatchWithContext({
      bot,
      context: progressContext(),
      streamMode: "progress",
      telegramCfg: progressConfig,
      runtime,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    // The cancelled final sends nothing; the no-reply notice that follows is its own final.
    const [[noticeId, notice] = []] = [...messages.entries()];
    expect(notice).toContain("couldn't produce or deliver a reply");
    expect(outcomeLines()).toEqual([
      "telegram final delivery outcome=skipped chat=123 reason=cancelled_by_message_sending_hook",
      `telegram final delivery outcome=sent chat=123 message=${noticeId}`,
    ]);
  });

  it("logs a preview send that may have landed as a retained outcome", async () => {
    const { bot, sendMessage } = await setupObservedProgressTransport();
    const { runtime, outcomeLines } = createLoggedRuntime();
    sendMessage.mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), {
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }),
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
      dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: "A final whose preview send is unconfirmed" }),
      }),
    );

    await dispatchWithContext({
      bot,
      context: progressContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
      runtime,
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(outcomeLines()).toEqual([
      "telegram final delivery outcome=preview-retained chat=123 reason=adapter_returned_no_identity",
    ]);
  });

  it("keeps a confirmed streamed answer when prompt-context recording fails", async () => {
    const { bot, messages, sendMessage } = await setupObservedProgressTransport();
    const { runtime, outcomeLines } = createLoggedRuntime();
    const status = createStatusReactionController();
    const preview = "Answer in progress while checking the completed result";
    const final = "Complete answer already accepted by Telegram";
    const contextFailure = new Error("prompt context recording failed");
    const recordContext = vi.fn(async () => {
      throw contextFailure;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: preview });
      await createTelegramDraftStream.mock.results[0]?.value?.flush();
      expect([...messages.values()]).toEqual([preview]);
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: final }),
      });
    });

    const result = await dispatchWithContext({
      bot,
      cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
      context: progressContext(status),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
      telegramDeps: {
        ...telegramDepsForTest,
        recordOutboundMessageForPromptContext: recordContext,
      },
      retryDispatchErrors: true,
      suppressFailureFallback: true,
      runtime,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result).toEqual({ kind: "completed" });
    expect([...messages.values()]).toEqual([final]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(recordContext).toHaveBeenCalledWith(
      expect.objectContaining({ text: final, messageId: [...messages.keys()][0] }),
    );
    expect(outcomeLines()).toEqual([
      `telegram final delivery outcome=preview-finalized-partial chat=123 message=${[...messages.keys()][0]}`,
    ]);
  });

  it("does not retry or erase an accepted final after late cancellation", async () => {
    const { bot, messages, sendMessage, deliver } = await setupObservedProgressTransport();
    const { runtime, outcomeLines } = createLoggedRuntime();
    const status = createStatusReactionController();
    const abortController = new AbortController();
    deliverReplies.mockImplementationOnce(async (params) => {
      const result = await deliver(params);
      abortController.abort(new Error("turn cancelled after final acceptance"));
      return result;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) =>
      dispatchThroughSharedOwner({
        ...params,
        replyResolver: async (_ctx, options) => {
          await emitToolStart(options, {
            name: "exec",
            phase: "start",
            toolCallId: "cleanup-1",
          });
          return { text: "Accepted final survives cleanup" };
        },
      }),
    );

    await dispatchWithContext({
      bot,
      context: progressContext(status),
      streamMode: "progress",
      telegramCfg: progressConfig,
      retryDispatchErrors: true,
      runtime,
      turnAdoptionLifecycle: {
        abortSignal: abortController.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(
      [...messages.values()].filter((text) => text === "Accepted final survives cleanup"),
    ).toEqual(["Accepted final survives cleanup"]);
    expect(
      sendMessage.mock.calls.filter(([, text]) => text === "Accepted final survives cleanup"),
    ).toHaveLength(1);
    expect(deliverReplies).toHaveBeenCalledOnce();
    expect(status.setError).not.toHaveBeenCalled();
    const finalId = [...messages.entries()].find(
      ([, text]) => text === "Accepted final survives cleanup",
    )?.[0];
    expect(outcomeLines()).toEqual([
      `telegram final delivery outcome=sent chat=123 message=${finalId}`,
    ]);
  });

  it.each(["accepted", "rejected"] as const)(
    "uses the second assistant preview as the current final when delivery is %s",
    async (outcome) => {
      const { bot, messages, sendMessage, editMessageText } =
        await setupObservedProgressTransport();
      const { runtime, outcomeLines } = createLoggedRuntime();
      const status = createStatusReactionController();
      const first = "First accepted answer";
      const partial = "Second answer in progress while inspecting the result";
      const second = "Second complete answer";
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: first }, { kind: "final" });
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: partial });
        await createTelegramDraftStream.mock.results[0]?.value?.flush();
        expect([...messages.values()]).toEqual([first, partial]);
        if (outcome === "rejected") {
          editMessageText.mockRejectedValueOnce(new Error("second final edit rejected"));
          sendMessage.mockRejectedValueOnce(new Error("second final send rejected"));
        }
        return dispatchThroughSharedOwner({
          ...params,
          replyResolver: async () => ({ text: second }),
        });
      });
      await dispatchWithContext({
        bot,
        cfg: { channels: { telegram: { botToken: "synthetic-test-token" } } },
        context: progressContext(status),
        streamMode: "partial",
        telegramCfg: { streaming: { mode: "partial" } },
        retryDispatchErrors: true,
        suppressFailureFallback: true,
        runtime,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      const visible = [...messages.entries()];
      expect(visible[0]?.[1]).toBe(first);
      // A final whose delivery throws logs its failure at error level, not an outcome.
      expect(outcomeLines()).toEqual(
        visible
          .slice(0, outcome === "accepted" ? 2 : 1)
          .map(
            ([id]) => `telegram final delivery outcome=preview-finalized chat=123 message=${id}`,
          ),
      );
      if (outcome === "rejected") {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("telegram final reply failed"),
        );
      }
      expect(sendMessage.mock.calls.filter(([, text]) => text === first)).toHaveLength(1);
      if (outcome === "accepted") {
        expect(visible).toHaveLength(2);
        expect(visible[1]?.[1]).toBe(second);
        expect(sendMessage.mock.calls.filter(([, text]) => text === second)).toHaveLength(0);
        expect(status.setDone).toHaveBeenCalledOnce();
        expect(status.setError).not.toHaveBeenCalled();
      } else {
        expect(visible.some(([, text]) => text === second)).toBe(false);
        expect(visible.some(([, text]) => text.includes("OpenClaw chat history"))).toBe(true);
        expect(sendMessage.mock.calls.filter(([, text]) => text === second)).toHaveLength(1);
        expect(status.setError).toHaveBeenCalledOnce();
        expect(status.setDone).not.toHaveBeenCalled();
      }
    },
  );
});

function replayedMessage(messageId: number): Message {
  return {
    message_id: messageId,
    date: 1736380800,
    chat: { id: 4242, type: "private" },
    from: { id: 77, is_bot: false, first_name: "Operator" },
    text: "does this answer twice?",
  } as Message;
}

/**
 * Runs one spooled attempt through the real message pipeline and its dispatch
 * dedupe guard. The attempt delivers a real final through dispatch, then the
 * reply queue abandons it before adoption, and the spool redelivers the update.
 */
async function abandonAfterVisibleFinal(streamMode: "partial" | "off", messageId: number) {
  const message = replayedMessage(messageId);
  const { bot, messages } = await setupObservedProgressTransport();
  const dispatchRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const final = "The answer this attempt already showed";
  const processMessage = vi.fn(async (args: { turnContext?: Record<string, unknown> }) => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      if (streamMode === "partial") {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({
          text: "The answer this attempt is streaming now",
        });
        await createTelegramDraftStream.mock.results[0]?.value?.flush();
      }
      return dispatchThroughSharedOwner({
        ...params,
        replyResolver: async () => ({ text: final }),
      });
    });
    await dispatchWithContext({
      bot,
      context: progressContext(),
      streamMode,
      telegramCfg: { streaming: { mode: streamMode } },
      runtime: dispatchRuntime,
    });
    const settle = args.turnContext?.finalizeSpooledReplayResult as (
      result: TelegramMessageProcessingResult,
    ) => Promise<TelegramMessageProcessingResult>;
    return await settle({ kind: "failed-retryable", error: new Error("turn-abandoned") });
  });
  const cfg = { channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } } } as OpenClawConfig;
  const pipeline = createTelegramMessagePipeline({
    accountId: "default",
    ownerAgentId: "main",
    bot: { api: {} },
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "tok" },
    telegramCfg: {},
    logger: getChildLogger({ module: "telegram/replay-guard-delivery-test" }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
    processMessage,
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      wasSentByBot: () => false,
      readChannelAllowFromStore: async () => [],
    },
  } as unknown as RegisterTelegramHandlerParams);
  const claimed = await pipeline.claimMessageDispatchDedupe(message, 99);
  const attempt = await runWithTelegramUpdateProcessingFrame(
    async () =>
      await pipeline.processMessageWithReplyChain({
        ctx: {
          message,
          update: { update_id: 991 },
        } as unknown as TelegramContext,
        msg: message,
        allMedia: [],
        storeAllowFrom: [],
        options: { spooledReplay: true },
        dispatchDedupeClaims: claimed.process ? claimed.claims : [],
      }),
  );
  const redelivered = await pipeline.claimMessageDispatchDedupe(message, 99);
  return {
    dispatchErrors: dispatchRuntime.error.mock.calls.map((args) => args.join(" ")),
    visible: [...messages.values()],
    final,
    firstProcess: claimed.process,
    attemptKind: attempt.value.kind,
    redeliveredProcess: redelivered.process,
  };
}

describeTelegramDispatch("Telegram replay guard after a visible final", () => {
  it.each([
    { path: "preview finalized in place", streamMode: "partial", messageId: 12949 },
    { path: "sent by the reply deliverer", streamMode: "off", messageId: 12950 },
  ] as const)(
    "refuses to replay an abandoned attempt whose final was $path",
    async ({ streamMode, messageId }) => {
      const run = await abandonAfterVisibleFinal(streamMode, messageId);

      expect(run.dispatchErrors).toEqual([]);
      expect(run.visible).toEqual([run.final]);
      expect(run.firstProcess).toBe(true);
      expect(run.attemptKind).toBe("failed-retryable");
      // A redelivery that processes again re-runs the turn: the answer shows twice.
      expect(run.redeliveredProcess).toBe(false);
    },
  );
});
