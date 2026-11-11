// Verifies runtime auth refresh timers stay within safe JavaScript timer bounds.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandQueueTaskDeadline } from "../process/command-queue.types.js";
import { OAUTH_REFRESH_INLOCK_TIMEOUT_MS } from "./auth-profiles/constants.js";
import {
  clampRuntimeAuthRefreshDelayMs,
  createRuntimeAuthDeadline,
  RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
  RuntimeAuthDeadlineError,
} from "./runtime-auth-refresh.js";

describe("clampRuntimeAuthRefreshDelayMs", () => {
  it("clamps far-future refresh delays to a timer-safe ceiling", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        refreshAt: 12_345_678_901_000,
        now: 0,
        minDelayMs: 60_000,
      }),
    ).toBe(2_147_483_647);
  });

  it("still respects the configured minimum delay", () => {
    expect(
      clampRuntimeAuthRefreshDelayMs({
        refreshAt: 1_000,
        now: 900,
        minDelayMs: 60_000,
      }),
    ).toBe(60_000);
  });
});

describe("createRuntimeAuthDeadline hard backstop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const unlimited: CommandQueueTaskDeadline = { kind: "unlimited" };
  it.each([
    ["the run has no timeout", { timeoutMs: MAX_TIMER_TIMEOUT_MS }],
    [
      "an approval wait leaves the attempt deadline unlimited",
      { timeoutMs: 600_000, getDeadline: () => unlimited },
    ],
    ["the run deadline is the 48h default", { timeoutMs: 48 * 60 * 60 * 1000 }],
  ])("rejects a hung step at the backstop when %s, leaving auth open", async (_case, options) => {
    vi.useFakeTimers();
    // A provider auth hook that hangs forever, the wedge that froze the gateway.
    // The backstop must reject so the single-flight handle can clear, without
    // closing auth the way the run deadline does.
    const auth = createRuntimeAuthDeadline({ provider: "openai", ...options });
    const raced = auth.run("runtime auth exchange", () => new Promise<string>(() => {}));
    const assertion = expect(raced).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RuntimeAuthDeadlineError &&
        err.message ===
          "Runtime auth operation for openai runtime auth exchange exceeded hard deadline (360000ms)",
    );
    await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
    await assertion;
    expect(auth.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the default hard timeout above two serialized in-lock budgets with headroom", () => {
    // Worst legitimate case: wait out a peer's full in-lock critical section,
    // then run our own (2 x OAUTH_REFRESH_INLOCK_TIMEOUT_MS). Explicit headroom
    // ensures legitimate contention never misreports as a hard timeout.
    const minHeadroomMs = 30_000;
    expect(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS).toBeGreaterThan(
      2 * OAUTH_REFRESH_INLOCK_TIMEOUT_MS + minHeadroomMs,
    );
  });
});
