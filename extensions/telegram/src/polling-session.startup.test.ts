/**
 * TelegramPollingSession startup edges: a worker-reported foreign offset, and a shutdown during
 * grammY's initialization retry backoff.
 *
 * Split out of ./polling-session.test.ts to keep that file within the max-lines budget.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { directUpdate, waitForTelegramTestState } from "./polling-session-spool.test-support.js";
import { TelegramPollingSession } from "./polling-session.js";
import { installTelegramIngressQueueRuntime } from "./runtime-state.test-support.js";
import { clearTelegramRuntimeForTest as clearTelegramRuntime } from "./runtime.test-support.js";
import type { TelegramIngressWorkerMessage } from "./telegram-ingress-worker.js";

const createTelegramBotMock = vi.hoisted(() => vi.fn());
const isRecoverableTelegramNetworkErrorMock = vi.hoisted(() => vi.fn(() => true));
const computeBackoffMock = vi.hoisted(() =>
  vi.fn((_policy: { initialMs: number }, _attempt: number) => 0),
);
const sleepWithAbortMock = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
const drainPendingDeliveriesMock = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));

// mock-isolation: These sessions inject their own bot; keep the full bot handler graph unloaded.
vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotMock,
}));

vi.mock("./network-errors.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./network-errors.js")>()),
  isRecoverableTelegramNetworkError: isRecoverableTelegramNetworkErrorMock,
}));

vi.mock("openclaw/plugin-sdk/delivery-queue-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/delivery-queue-runtime")>()),
  drainPendingDeliveries: drainPendingDeliveriesMock,
}));

vi.mock("./api-logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api-logging.js")>()),
  withTelegramApiErrorLogging: async ({ fn }: { fn: () => Promise<unknown> }) => await fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  computeBackoff: computeBackoffMock,
  createSubsystemLogger: vi.fn(() => {
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      isEnabled: vi.fn(() => false),
      child: vi.fn(() => logger),
    };
    return logger;
  }),
  formatDurationPrecise: vi.fn((ms: number) => `${ms}ms`),
  sleepWithAbort: sleepWithAbortMock,
}));

type WorkerMessageListener = (message: TelegramIngressWorkerMessage) => void;
type AsyncVoidFn = () => Promise<void>;
type MockCallSource = { mock: { calls: Array<Array<unknown>> } };
type SessionOptions = ConstructorParameters<typeof TelegramPollingSession>[0];
type IsolatedIngressOptions = NonNullable<SessionOptions["ingress"]>;
const noop: AsyncVoidFn = async () => undefined;

function makeWorker(
  task: AsyncVoidFn = noop,
  stop: AsyncVoidFn = noop,
): {
  task: Mock<AsyncVoidFn>;
  stop: Mock<AsyncVoidFn>;
  onMessage?: WorkerMessageListener;
} {
  return {
    task: vi.fn(task),
    stop: vi.fn(stop),
  };
}

function statusPatches(source: MockCallSource): Record<string, unknown>[] {
  return source.mock.calls.map((call, index) => {
    const patch = call[0];
    if (!patch || typeof patch !== "object") {
      throw new Error(`Expected status patch call ${index} to be an object`);
    }
    return patch as Record<string, unknown>;
  });
}

function makeIsolatedBot(handleUpdate: (update: { update_id?: number }) => Promise<unknown>) {
  return {
    api: {
      deleteWebhook: vi.fn(async () => true),
      config: { use: vi.fn() },
    },
    init: vi.fn(noop),
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: "OpenClaw",
      username: "openclaw_bot",
      has_topics_enabled: false,
    } as NonNullable<SessionOptions["botInfo"]>,
    handleUpdate: vi.fn(handleUpdate),
    stop: vi.fn(noop),
  };
}

function makeTelegramTransport() {
  return {
    fetch: globalThis.fetch,
    sourceFetch: globalThis.fetch,
    close: vi.fn(noop),
  };
}

function createPollingSession(
  params: Pick<SessionOptions, "abortSignal" | "ingress"> & Partial<SessionOptions>,
) {
  return new TelegramPollingSession({
    token: "tok",
    config: {},
    accountId: "default",
    runtime: undefined,
    proxyFetch: undefined,
    ...params,
    getCommittedUpdateId: params.getCommittedUpdateId ?? (() => null),
    persistUpdateId: params.persistUpdateId ?? (async () => undefined),
    log: params.log ?? (() => undefined),
  });
}

async function withTempSpool<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-spool-"));
  try {
    return await fn(stateDir);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createListeningIngressWorker() {
  let listener: WorkerMessageListener | undefined;
  const workerDone = createDeferred<void>();
  const workerStop = vi.fn(async () => {
    workerDone.resolve();
  });
  const createWorker = vi.fn(() => {
    const worker = makeWorker(async () => {
      await workerDone.promise;
    }, workerStop);
    return {
      ...worker,
      ackSpooledUpdate: vi.fn(),
      set onMessage(nextListener: WorkerMessageListener | undefined) {
        listener = nextListener;
      },
    };
  });
  return {
    createWorker,
    emit: (message: TelegramIngressWorkerMessage) => listener?.(message),
    hasListener: () => listener !== undefined,
  };
}

function startIsolatedIngressSession(params: {
  abort: AbortController;
  stateDir: string;
  handleUpdate: (update: { update_id?: number }) => Promise<void>;
  createWorker: IsolatedIngressOptions["createWorker"];
  getCommittedUpdateId: () => number | null;
  log: (message: string) => void;
  persistUpdateId: SessionOptions["persistUpdateId"];
  resetUpdateOffset: SessionOptions["resetUpdateOffset"];
}) {
  createTelegramBotMock.mockReturnValueOnce(makeIsolatedBot(params.handleUpdate));
  const session = createPollingSession({
    abortSignal: params.abort.signal,
    getCommittedUpdateId: params.getCommittedUpdateId,
    log: params.log,
    persistUpdateId: params.persistUpdateId,
    resetUpdateOffset: params.resetUpdateOffset,
    ingress: {
      createWorker: params.createWorker,
      drainIntervalMs: 10,
      stateDir: params.stateDir,
    },
  });
  return { runPromise: session.runUntilAbort() };
}

describe("TelegramPollingSession", () => {
  beforeEach(() => {
    createTelegramBotMock.mockReset();
    isRecoverableTelegramNetworkErrorMock.mockReset().mockReturnValue(true);
    computeBackoffMock.mockReset().mockReturnValue(0);
    sleepWithAbortMock.mockReset().mockResolvedValue(undefined);
    drainPendingDeliveriesMock.mockReset().mockResolvedValue(undefined);
    installTelegramIngressQueueRuntime(() =>
      path.join(os.tmpdir(), "openclaw-telegram-test-state"),
    );
  });

  afterEach(async () => {
    clearTelegramRuntime();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("drops the persisted offset when the worker reports a foreign offset", async () => {
    await withTempSpool(async (tempDir) => {
      const abort = new AbortController();
      const handleUpdate = vi.fn(async () => undefined);
      const worker = createListeningIngressWorker();
      const resetUpdateOffset = vi.fn(async () => undefined);
      const persistUpdateId = vi.fn(async () => undefined);
      const log = vi.fn();
      const { runPromise } = startIsolatedIngressSession({
        abort,
        stateDir: tempDir,
        handleUpdate,
        createWorker: worker.createWorker,
        getCommittedUpdateId: () => 760_546_622,
        persistUpdateId,
        resetUpdateOffset,
        log,
      });
      try {
        await waitForTelegramTestState(() => expect(worker.hasListener()).toBe(true));
        worker.emit({
          type: "offset-rejected",
          requestedOffset: 760_546_623,
          adoptedUpdateId: 592_426_180,
        });
        // The reset must land before the adopted update's offset is persisted.
        expect(resetUpdateOffset).toHaveBeenCalledTimes(1);
        expect(persistUpdateId).not.toHaveBeenCalled();
        worker.emit({
          type: "updates",
          requestId: "foreign-1",
          updates: [directUpdate(592_426_180, 123, "head")],
          queued: 1,
        });
        await waitForTelegramTestState(() =>
          expect(persistUpdateId).toHaveBeenCalledWith(592_426_180),
        );
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("ignored offset 760546623 and answered from update 592426180"),
        );
      } finally {
        abort.abort();
        await runPromise;
      }
    });
  });

  it("settles aborted grammY initialization during network retry backoff without starting ingress", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const transport = makeTelegramTransport();
    const fetch = vi.fn(async () => {
      throw new TypeError("offline Telegram fixture");
    });
    const bot = new Bot("tok", {
      client: {
        fetch: asTelegramClientFetch(
          createTelegramClientFetch({
            fetchImpl: asTelegramClientFetch(fetch),
            shutdownSignal: abort.signal,
          }),
        ),
      },
    });
    vi.spyOn(bot.api, "deleteWebhook").mockResolvedValue(true);
    createTelegramBotMock.mockReturnValueOnce(bot);
    const createWorker = vi.fn(() => makeWorker());
    const setStatus = vi.fn();
    const session = createPollingSession({
      abortSignal: abort.signal,
      telegramTransport: transport,
      setStatus,
      ingress: { createWorker },
    });
    let settled = false;
    const runPromise = session.runUntilAbort().then(() => {
      settled = true;
    });
    try {
      // grammY retries HttpError once immediately, then waits 100 ms. Keep
      // that real dependency delay pending while the account is canceled.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      expect(settled).toBe(false);
      expect(bot.isInited()).toBe(false);
      expect(transport.close).not.toHaveBeenCalled();

      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(createWorker).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(transport.close).toHaveBeenCalledOnce();
      expect(statusPatches(setStatus).at(-1)).toEqual({ mode: "polling", connected: false });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      abort.abort();
      // Also settle the broken-base negative control without leaving a retry
      // timer or an unobserved session behind after its assertion fails.
      vi.spyOn(bot.api, "getMe").mockRejectedValue(new Error("test cleanup"));
      await vi.advanceTimersByTimeAsync(100);
      await runPromise;
      vi.useRealTimers();
    }
  });
});
