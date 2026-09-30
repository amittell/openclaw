/**
 * Upstream #132409's update-tracker test, in its own file because
 * bot.create-telegram-bot.test.ts is over the line cap and the ratchet rejects
 * growth there. Subject: the deferred-work branch of the update tracker in
 * bot-core.ts, for a spooled update whose claim owner aborted while it was
 * pending.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { runTelegramTestMiddlewareChain } from "./bot.test-helpers.js";

// The harness installs vi.doMock runtime overrides before the bot module is loaded.
const { middlewareUseSpy, telegramBotDepsForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBotCore } = await import("./bot-core.js");
const { createTelegramSpooledReplayDeferredParticipant, runWithTelegramSpooledReplayUpdate } =
  await import("./bot-processing-outcome.js");

let stateDir: string | undefined;
let previousStateDir: string | undefined;

async function flushTelegramTestMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Telegram update tracker for owner-aborted spooled work", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-owner-abort-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("retries a deferred spooled update that finishes after its owner aborts", async () => {
    const onUpdateId = vi.fn<(updateId: number) => void | Promise<void>>();
    createTelegramBotCore({
      token: "tok",
      botInfo: telegramBotInfoForTest,
      telegramDeps: telegramBotDepsForTest,
      updateOffset: { lastUpdateId: 710, onUpdateId },
    });
    const runMiddlewareChain = (ctx: Record<string, unknown>, finalNext: () => Promise<void>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, async () => finalNext());
    const owner = new AbortController();
    const update = { update_id: 711 };
    const replay = await runWithTelegramSpooledReplayUpdate(
      update,
      async () => {
        await runMiddlewareChain({ update }, async () => {
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:watchdog-owner-abort",
          );
          if (!participant) {
            throw new Error("expected spooled replay participant");
          }
        });
      },
      {
        abortSignal: owner.signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAdoptionFinalizing: vi.fn(),
        onAbandoned: vi.fn(),
      },
    );
    const deferredWork = replay.deferredWork;
    if (!deferredWork) {
      throw new Error("expected deferred spooled work");
    }

    owner.abort(new Error("claim adoption watchdog fired"));
    deferredWork.settle({ kind: "completed" });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    const retryHandler = vi.fn();
    await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        retryHandler();
      });
    });
    await flushTelegramTestMicrotasks();
    expect(retryHandler).toHaveBeenCalledTimes(1);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([711]);
  });
});
