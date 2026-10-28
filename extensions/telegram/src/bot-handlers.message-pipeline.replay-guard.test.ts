/** Verifies the ingress replay guard reads the visible-reply fact of its own attempt. */
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import {
  createTelegramMessagePipeline,
  type TelegramMessagePipeline,
} from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import {
  markTelegramVisibleReplyDelivered,
  runWithTelegramUpdateProcessingFrame,
  type TelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import type { TelegramContext } from "./bot/types.js";

type SettleSpooledReplay = (
  result: TelegramMessageProcessingResult,
) => Promise<TelegramMessageProcessingResult>;

const BOT_USER_ID = 99;
const SPOOLED_MESSAGE = {
  message_id: 12949,
  date: 1736380800,
  chat: { id: 4242, type: "private" },
  from: { id: 77, is_bot: false, first_name: "Operator" },
  text: "does this answer twice?",
} as Message;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-telegram-replay-guard-");
  resetPluginStateStoreForTests({ closeDatabase: false });
});

afterEach(() => {
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

/**
 * Builds the real pipeline over the real dispatch-dedupe guard. The stubbed
 * message processor hands back the retained `finalizeSpooledReplayResult` and
 * then stays pending, exactly as a deferred turn does while the reply queue owns
 * it, so the test can settle the attempt from a context the attempt never owned.
 */
function createPipelineUnderTest(): {
  pipeline: TelegramMessagePipeline;
  dispatched: Promise<SettleSpooledReplay>;
  replyDuringDispatch: { enabled: boolean };
  turnResult: ReturnType<typeof createDeferred<TelegramMessageProcessingResult>>;
} {
  const dispatched = createDeferred<SettleSpooledReplay>();
  const turnResult = createDeferred<TelegramMessageProcessingResult>();
  const replyDuringDispatch = { enabled: false };
  const cfg = { channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } } } as OpenClawConfig;
  const processMessage = vi.fn(async (args: { turnContext?: Record<string, unknown> }) => {
    if (replyDuringDispatch.enabled) {
      markTelegramVisibleReplyDelivered();
    }
    dispatched.resolve(args.turnContext?.finalizeSpooledReplayResult as SettleSpooledReplay);
    return await turnResult.promise;
  });
  const params = {
    accountId: "default",
    ownerAgentId: "main",
    bot: { api: {} } as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "tok" },
    telegramCfg: {},
    logger: getChildLogger({ module: "telegram/replay-guard-test" }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
    processMessage: processMessage as unknown as RegisterTelegramHandlerParams["processMessage"],
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      wasSentByBot: () => false,
      readChannelAllowFromStore: async () => [],
    },
  } as unknown as RegisterTelegramHandlerParams;
  return {
    pipeline: createTelegramMessagePipeline(params),
    dispatched: dispatched.promise,
    replyDuringDispatch,
    turnResult,
  };
}

function dispatchSpooledAttempt(
  pipeline: TelegramMessagePipeline,
  claims: Awaited<ReturnType<TelegramMessagePipeline["claimMessageDispatchDedupe"]>>,
) {
  return runWithTelegramUpdateProcessingFrame(
    async () =>
      await pipeline.processMessageWithReplyChain({
        ctx: { message: SPOOLED_MESSAGE, update: { update_id: 991 } } as unknown as TelegramContext,
        msg: SPOOLED_MESSAGE,
        allMedia: [],
        storeAllowFrom: [],
        options: { spooledReplay: true },
        dispatchDedupeClaims: claims.process ? claims.claims : [],
      }),
  );
}

describe("Telegram spooled ingress replay guard", () => {
  it("suppresses the redelivery of an attempt that replied before the queue abandoned it", async () => {
    // The reviewer-requested sequence in one trace: confirmed send -> abandonment
    // settled on the queue's own chain (outside this update's frame) -> the spool
    // redelivery of the same logical message is refused as a duplicate.
    const trace: string[] = [];
    const { pipeline, dispatched, replyDuringDispatch, turnResult } = createPipelineUnderTest();
    const claimed = await pipeline.claimMessageDispatchDedupe(SPOOLED_MESSAGE, BOT_USER_ID);
    trace.push(`claim attempt=1 process=${claimed.process}`);

    replyDuringDispatch.enabled = true;
    const dispatch = dispatchSpooledAttempt(pipeline, claimed);
    const settleFromQueueChain = await dispatched;
    trace.push(`outbound send ok chatId=${SPOOLED_MESSAGE.chat.id} replyToMessageId=<redacted>`);

    const settled = await settleFromQueueChain({
      kind: "failed-retryable",
      error: new Error("turn-abandoned"),
    });
    turnResult.resolve(settled);
    await dispatch;
    trace.push(`settled kind=${settled.kind}`);

    const redelivered = await pipeline.claimMessageDispatchDedupe(SPOOLED_MESSAGE, BOT_USER_ID);
    trace.push(`claim attempt=2 process=${redelivered.process}`);

    expect(trace).toEqual([
      "claim attempt=1 process=true",
      "outbound send ok chatId=4242 replyToMessageId=<redacted>",
      "settled kind=failed-retryable",
      "claim attempt=2 process=false",
    ]);
  });

  it("redelivers an abandoned attempt that never replied, even while another update's frame is current", async () => {
    // Settlement runs on the followup drain chain, whose frame belongs to
    // whichever update rooted it. Committing on that update's reply would drop
    // this message without ever answering it.
    const trace: string[] = [];
    const { pipeline, dispatched, turnResult } = createPipelineUnderTest();
    const claimed = await pipeline.claimMessageDispatchDedupe(SPOOLED_MESSAGE, BOT_USER_ID);
    trace.push(`claim attempt=1 process=${claimed.process}`);

    const dispatch = dispatchSpooledAttempt(pipeline, claimed);
    const settleFromQueueChain = await dispatched;

    const foreign = await runWithTelegramUpdateProcessingFrame(async () => {
      markTelegramVisibleReplyDelivered();
      trace.push("outbound send ok update=other-attempt");
      return await settleFromQueueChain({
        kind: "failed-retryable",
        error: new Error("turn-abandoned"),
      });
    });
    turnResult.resolve(foreign.value);
    await dispatch;
    trace.push(`settled kind=${foreign.value.kind}`);

    const redelivered = await pipeline.claimMessageDispatchDedupe(SPOOLED_MESSAGE, BOT_USER_ID);
    trace.push(`claim attempt=2 process=${redelivered.process}`);

    expect(trace).toEqual([
      "claim attempt=1 process=true",
      "outbound send ok update=other-attempt",
      "settled kind=failed-retryable",
      "claim attempt=2 process=true",
    ]);
  });
});
