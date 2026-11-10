// FORK DIVERGENCE (#132409): the Telegram durable-ingress stall watchdog holds a timed-out
// claim until its original dispatch returns, then releases it for one retry. Upstream
// (#169202, 6d624f3af2a) re-queues it as pending with handler-timeout while the original
// middleware still waits, and the retry records "still pending" until it returns; its test
// of that in telegram-ingress-coalescing.e2e.test.ts is replaced by this fork-only file.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTelegramChannelInboundEventWithHarness } from "./bot.test-helpers.js";
import type {
  TelegramIngressMonitorOptions,
  TelegramIngressResources,
} from "./telegram-ingress-coalescing-fixture.test-support.js";
import { textUpdate } from "./telegram-ingress-coalescing.test-support.js";

const downstreamTurns = vi.hoisted(() =>
  vi.fn(
    async (
      _ctx: MsgContext,
      _abortSignal?: AbortSignal,
      _turnAdoptionLifecycle?: GetReplyOptions["turnAdoptionLifecycle"],
    ) => ({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    }),
  ),
);
const inboundTurns = vi.hoisted(() => ({ active: new Set<Promise<void>>() }));
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-claim-hold-ingress-");

// mock-isolation: Bot API traffic goes to the fixture transport, never a proxy or the network.
vi.mock("./fetch.js", () => ({
  resolveTelegramApiBase: (apiRoot?: string) => apiRoot ?? "https://api.telegram.org",
  resolveTelegramFetch: (proxyFetch?: typeof fetch) => proxyFetch ?? globalThis.fetch,
  resolveTelegramTransport: (proxyFetch?: typeof fetch) => {
    const fetchImpl = proxyFetch ?? globalThis.fetch;
    return { fetch: fetchImpl, sourceFetch: fetchImpl, close: async () => {} };
  },
  shouldRetryTelegramTransportFallback: () => false,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      const turn = runTelegramChannelInboundEventWithHarness(actual, params, (dispatchParams) =>
        downstreamTurns(
          dispatchParams.ctx,
          dispatchParams.replyOptions?.abortSignal,
          dispatchParams.replyOptions?.turnAdoptionLifecycle,
        ),
      );
      const settled = turn.then(
        () => {},
        () => {},
      );
      inboundTurns.active.add(settled);
      void settled.then(() => {
        inboundTurns.active.delete(settled);
      });
      return await turn;
    },
  };
});

// mock-isolation: Agent directories and the default model come from the fixture, not host state.
vi.mock("./bot-handlers.agent.runtime.js", () => ({
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
}));

// mock-isolation: Dispatch reads the fixture model catalog, not the host agent catalog.
vi.mock("./bot-message-dispatch.agent.runtime.js", () => ({
  findModelInCatalog: vi.fn(() => undefined),
  loadPreparedModelCatalog: vi.fn(async () => []),
  modelSupportsVision: vi.fn(() => false),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-test" })),
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

// Preserve production initialization order before the fixture imports those modules.
await import("./bot.js");
await import("openclaw/plugin-sdk/reply-runtime");
await import("./telegram-ingress-drain-factory.js");
await import("./runtime.js");
await import("./runtime.test-support.js");
const { openTelegramIngressQueue, telegramQueueEventId } =
  await import("./telegram-ingress-spool.js");
const processingOutcome = await import("./bot-processing-outcome.js");
const {
  assertSpoolTombstoned,
  createIngressMonitor,
  releaseIngressCase,
  resetTelegramIngressRuntime,
  runtimeErrors,
} = await import("./telegram-ingress-coalescing-fixture.test-support.js");

describe("Telegram durable ingress stall watchdog (fork claim hold)", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let stateDir: string;
  let activeResources: TelegramIngressResources[];

  beforeEach(async () => {
    stateDir = sessionDirs.make();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    activeResources = [];
    runtimeErrors.length = 0;
    downstreamTurns
      .mockReset()
      .mockResolvedValue({ queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } });
    resetTelegramIngressRuntime();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await releaseIngressCase(activeResources, inboundTurns.active, stateDir);
    resetPluginStateStoreForTests({ closeDatabase: false });
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  async function createMonitor(options: TelegramIngressMonitorOptions = {}) {
    const resources = await createIngressMonitor(stateDir, options);
    activeResources.push(resources);
    return resources;
  }

  it("holds a timed-out update's claim until its original middleware returns, then retries it once", async ({
    signal,
  }) => {
    // The monitor captures Date.now at construction, so install the clock first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const enteredBlocker = createDeferred<void>();
    const finishBlocker = createDeferred<void>();
    downstreamTurns.mockImplementationOnce(async () => {
      enteredBlocker.resolve();
      await finishBlocker.promise;
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    const { monitor, bot } = await createMonitor({
      adoptionStallTimeoutMs: 300_000,
      pollIntervalMs: 60_000,
      onRuntimeError: vi.fn(),
    });
    const blocker = bot.handleUpdate(
      textUpdate({ updateId: 801, messageId: 1, text: "busy turn" }),
    );
    // Lets the drain's durable writes land without moving the clock.
    const flushDrain = async () => {
      for (let turn = 0; turn < 25; turn += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    };
    try {
      await withinTest(enteredBlocker.promise, signal);
      const handleUpdate = vi.spyOn(bot, "handleUpdate");
      const handledIds = () => handleUpdate.mock.calls.map(([update]) => update.update_id);
      const queued = textUpdate({ updateId: 802, messageId: 2, text: "deliver this later" });
      const tail = textUpdate({ updateId: 803, messageId: 3, text: "deliver after the retry" });
      const eventId = telegramQueueEventId(802);
      const queue = openTelegramIngressQueue({ stateDir });
      const custody = async () => ({
        pending: await queue.listPending({ limit: "all" }),
        claims: await queue.listClaims(),
        failed: (await queue.listFailed?.({ limit: "all" })) ?? [],
      });
      monitor.start();

      await withinTest(monitor.admit(queued), signal);
      await withinTest(
        vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledTimes(1)),
        signal,
      );
      await withinTest(vi.advanceTimersByTimeAsync(300_000), signal);
      await flushDrain();
      // The watchdog has fired, but the claim stays with the waiting original.
      const held = await custody();
      expect(held).toMatchObject({ pending: [], failed: [], claims: [{ attempts: 0 }] });
      expect(held.claims.map((c) => [c.id, c.lastError])).toEqual([[eventId, undefined]]);

      await withinTest(monitor.admit(tail), signal);
      await withinTest(vi.advanceTimersByTimeAsync(1_000), signal);
      monitor.requestDrain();
      await flushDrain();
      // The same-lane follower waits behind the held claim, which is not retried yet.
      expect(await custody()).toMatchObject({
        pending: [{ id: telegramQueueEventId(803), attempts: 0 }],
        claims: [{ id: eventId, attempts: 0 }],
      });
      expect(handledIds()).toEqual([802]);
      expect(downstreamTurns).toHaveBeenCalledTimes(1);

      finishBlocker.resolve();
      await blocker;
      await monitor.waitForIdle();
      await vi.advanceTimersByTimeAsync(2_000);
      monitor.requestDrain();
      await monitor.waitForIdle();
      await flushDrain();
      // The original returns, the released claim is retried once, then the follower runs.
      expect(handledIds()).toEqual([802, 802, 803]);
      expect(downstreamTurns.mock.calls.map(([ctx]) => ctx.RawBody)).toEqual([
        "busy turn",
        "deliver this later",
        "deliver after the retry",
      ]);
      // Nothing is left pending, claimed or failed, and both updates are tombstoned.
      await assertSpoolTombstoned({ stateDir, updateIds: [802, 803] });
      const duplicate = await processingOutcome.runWithTelegramUpdateProcessingFrame(() =>
        bot.handleUpdate(queued),
      );
      expect(duplicate.result).toEqual({ kind: "skipped" });
      expect(downstreamTurns).toHaveBeenCalledTimes(3);
    } finally {
      finishBlocker.resolve();
      await blocker;
      await monitor.stop();
    }
  });
});
