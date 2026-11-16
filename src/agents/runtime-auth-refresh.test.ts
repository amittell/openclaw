// Fork-only (#93952): the hard backstop on one runtime auth step. beta.4 deleted
// upstream's clamp tests from this file in #182997; only the fork's cases remain.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandQueueTaskDeadline } from "../process/command-queue.types.js";
import { OAUTH_REFRESH_INLOCK_TIMEOUT_MS } from "./auth-profiles/constants.js";
import {
  createRuntimeAuthDeadline,
  RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
  RuntimeAuthDeadlineError,
} from "./runtime-auth-refresh.js";

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
