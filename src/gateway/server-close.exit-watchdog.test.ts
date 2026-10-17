import "./server-close.mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createGatewayCloseTestDepsFactory,
  createGatewayCloseTestHandlerFactory,
} from "./server-close.test-support.js";
const { mocks, resetServerCloseMocks } = await import("./server-close.mocks.test-support.js");

const serverClose = await import("./server-close.js");
const { isGatewayShuttingDown, resetGatewayShuttingDownForTest } = serverClose;
const createGatewayCloseHandler = createGatewayCloseTestHandlerFactory(serverClose);
const { armGatewayPostShutdownExitWatchdog } = await import("./server-close-exit-watchdog.js");
const { finishGatewayRestartTrace, resetGatewayRestartTraceForTest } =
  await import("./restart-trace.js");
const originalRestartTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;

const createGatewayCloseTestDeps = createGatewayCloseTestDepsFactory(mocks);

describe("createGatewayCloseHandler", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    vi.useRealTimers();
    resetServerCloseMocks();
  });

  afterEach(() => {
    finishGatewayRestartTrace("test.finish");
    resetPluginRuntimeStateForTest();
    vi.useRealTimers();
    resetGatewayRestartTraceForTest();
    resetGatewayShuttingDownForTest();
    if (originalRestartTraceEnv === undefined) {
      delete process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    } else {
      process.env.OPENCLAW_GATEWAY_RESTART_TRACE = originalRestartTraceEnv;
    }
  });

  it("flips the shutting-down flag before any close await", async () => {
    let observedDuringShutdown: boolean | undefined;
    const deps = createGatewayCloseTestDeps({
      bonjourStop: async () => {
        observedDuringShutdown = isGatewayShuttingDown();
      },
    });
    const close = createGatewayCloseHandler(deps);
    expect(isGatewayShuttingDown()).toBe(false);

    await close({ reason: "test" });

    expect(observedDuringShutdown).toBe(true);
    expect(isGatewayShuttingDown()).toBe(true);
  });

  it("arms the post-shutdown exit watchdog with the clean reason and duration", async () => {
    // Typed mock signature mirrors the production injection point so the
    // `mock.calls[0][0]` access stays index-safe under tsgo's strict mode.
    const armPostShutdownExitWatchdog = vi.fn<
      (opts: { reason: string; shutdownDurationMs: number }) => { cancel: () => void } | null
    >(() => null);
    const deps = createGatewayCloseTestDeps({ armPostShutdownExitWatchdog });
    const close = createGatewayCloseHandler(deps);

    const result = await close({ reason: "test" });

    expect(armPostShutdownExitWatchdog).toHaveBeenCalledTimes(1);
    const armArgs = armPostShutdownExitWatchdog.mock.calls[0]?.[0];
    expect(armArgs?.reason).toBe("test");
    expect(armArgs?.shutdownDurationMs).toBe(result.durationMs);
  });

  // The in-process restart path closes and then immediately starts the next
  // gateway iteration in the same process. Restart reasons must skip the
  // watchdog so it cannot kill the restarted gateway.
  it("skips the post-shutdown exit watchdog on in-process restart close reasons", async () => {
    const armPostShutdownExitWatchdog = vi.fn<
      (opts: { reason: string; shutdownDurationMs: number }) => { cancel: () => void } | null
    >(() => null);
    const deps = createGatewayCloseTestDeps({ armPostShutdownExitWatchdog });
    const close = createGatewayCloseHandler(deps);

    await close({ reason: "gateway restarting" });

    expect(armPostShutdownExitWatchdog).not.toHaveBeenCalled();
  });

  // startGatewayServer is reused by onboarding's session gateway, which handles
  // a startup failure and continues the wizard. Without owner opt-in, close
  // must never arm process.exit, even for failed-startup cleanup.
  it("never arms the post-shutdown exit watchdog without the process-owner opt-in", async () => {
    const armPostShutdownExitWatchdog = vi.fn<
      (opts: { reason: string; shutdownDurationMs: number }) => { cancel: () => void } | null
    >(() => null);
    const deps = createGatewayCloseTestDeps({
      armPostShutdownExitWatchdog,
      postShutdownExitWatchdogEnabled: undefined,
    });
    const close = createGatewayCloseHandler(deps);

    await close({ reason: "gateway startup failed", postShutdownExitCode: 1 });
    await close({ reason: "onboarding finished" });

    expect(armPostShutdownExitWatchdog).not.toHaveBeenCalled();
  });

  it("arms the watchdog for ordinary stop reasons even when other dep mocks differ", async () => {
    // Sibling assertion to the restart-skip case above. Confirms the
    // restart-aware gate only suppresses on restart-shaped reasons.
    const armPostShutdownExitWatchdog = vi.fn<
      (opts: { reason: string; shutdownDurationMs: number }) => { cancel: () => void } | null
    >(() => null);
    const deps = createGatewayCloseTestDeps({ armPostShutdownExitWatchdog });
    const close = createGatewayCloseHandler(deps);

    await close({ reason: "gateway stopping" });

    expect(armPostShutdownExitWatchdog).toHaveBeenCalledTimes(1);
  });

  // The forced-exit status distinguishes a clean stop from failed-startup
  // cleanup so a failure-only supervisor relaunches.
  it("threads the intended forced-exit status into the watchdog (0 clean, nonzero on startup failure)", async () => {
    const armPostShutdownExitWatchdog = vi.fn<
      (opts: { reason: string; shutdownDurationMs: number; exitCode?: number }) => {
        cancel: () => void;
      } | null
    >(() => null);
    const deps = createGatewayCloseTestDeps({ armPostShutdownExitWatchdog });
    const close = createGatewayCloseHandler(deps);

    await close({ reason: "gateway stopping" });
    expect(armPostShutdownExitWatchdog.mock.calls[0]?.[0]?.exitCode).toBe(0);

    armPostShutdownExitWatchdog.mockClear();
    await close({ reason: "gateway startup failed", postShutdownExitCode: 1 });
    expect(armPostShutdownExitWatchdog.mock.calls[0]?.[0]?.exitCode).toBe(1);
  });
});

describe("armGatewayPostShutdownExitWatchdog", () => {
  it("forces process.exit(0) when the node process is still alive after the timeout", async () => {
    vi.useFakeTimers();
    const exitProcess = vi.fn();
    const handle = armGatewayPostShutdownExitWatchdog({
      timeoutMs: 25,
      exitProcess,
      reason: "gateway stopping",
      shutdownDurationMs: 5,
    });
    expect(exitProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30);
    expect(exitProcess).toHaveBeenCalledWith(0);
    handle.cancel();
    vi.useRealTimers();
  });

  it("forces the provided nonzero exit status for a failed-startup cleanup", async () => {
    vi.useFakeTimers();
    const exitProcess = vi.fn();
    const handle = armGatewayPostShutdownExitWatchdog({
      timeoutMs: 25,
      exitProcess,
      reason: "gateway startup failed",
      shutdownDurationMs: 5,
      exitCode: 1,
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(exitProcess).toHaveBeenCalledWith(1);
    handle.cancel();
    vi.useRealTimers();
  });

  it("waits the 5s default when no timeout is passed", async () => {
    vi.useFakeTimers();
    const exitProcess = vi.fn();
    const handle = armGatewayPostShutdownExitWatchdog({
      exitProcess,
      reason: "gateway stopping",
      shutdownDurationMs: 5,
    });
    await vi.advanceTimersByTimeAsync(4995);
    expect(exitProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(exitProcess).toHaveBeenCalledWith(0);
    handle.cancel();
    vi.useRealTimers();
  });

  it("does not call exit when the watchdog is cancelled before the timeout", async () => {
    vi.useFakeTimers();
    const exitProcess = vi.fn();
    const handle = armGatewayPostShutdownExitWatchdog({
      timeoutMs: 50,
      exitProcess,
      reason: "test",
      shutdownDurationMs: 1,
    });
    handle.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(exitProcess).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("emits a zombie_detected warn log with handle summary when fired", async () => {
    vi.useFakeTimers();
    const exitProcess = vi.fn();
    mocks.logWarn.mockClear();
    armGatewayPostShutdownExitWatchdog({
      timeoutMs: 10,
      exitProcess,
      reason: "telegram zombie",
      shutdownDurationMs: 7,
    });
    await vi.advanceTimersByTimeAsync(15);
    const warnMessages = mocks.logWarn.mock.calls.map(([message]) => String(message));
    expect(warnMessages.some((message) => message.includes("still alive after 10ms"))).toBe(true);
    expect(warnMessages.some((message) => message.includes("forcing process.exit(0)"))).toBe(true);
    vi.useRealTimers();
  });
});
