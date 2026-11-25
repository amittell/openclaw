/**
 * Post-shutdown exit watchdog wiring for gateway close: the close params that gate the
 * process-wide force-exit, and the decision to arm it once every owned subsystem has closed.
 * Split out of ./server-close.ts to keep that module within the max-lines budget.
 */
import { armGatewayPostShutdownExitWatchdog } from "./server-close-exit-watchdog.js";

export type GatewayPostShutdownExitWatchdogParams = {
  // Test seam: vitest workers replace this with a no-op so the watchdog cannot
  // exit the worker mid-suite. Production callers leave it undefined so the
  // canonical `armGatewayPostShutdownExitWatchdog` runs.
  armPostShutdownExitWatchdog?: (opts: {
    reason: string;
    shutdownDurationMs: number;
    exitCode?: number;
  }) => { cancel: () => void } | null;
  // Process-ownership gate: only the terminal gateway CLI/daemon path may arm the
  // post-shutdown force-exit. Embedded starts (onboarding session gateway, test
  // harnesses) must stay process-neutral or a handled close would kill the host.
  postShutdownExitWatchdogEnabled?: boolean;
};

/** Runs after a clean resource close; a close that throws never arms the watchdog. */
export function armPostCloseExitWatchdog(
  params: GatewayPostShutdownExitWatchdogParams,
  reason: string,
  shutdownDurationMs: number,
  exitCode: number | undefined,
): void {
  // Arm a process-wide watchdog so a stray handle cannot keep the node process
  // (and its HTTP listener) alive after every owned subsystem has closed. The
  // unref'd timer is a no-op when natural exit wins.
  //
  // Skipped for in-process restart reasons (the SIGUSR1 path closes and then
  // immediately starts the next gateway iteration in the same node process):
  // there the process is intentionally kept alive, so the timer would fire a
  // few seconds later and exit the freshly restarted gateway.
  const armWatchdog = params.armPostShutdownExitWatchdog ?? armGatewayPostShutdownExitWatchdog;
  const isInProcessRestart = /\brestart(ing|ed)?\b/i.test(reason);
  if (!isInProcessRestart && params.postShutdownExitWatchdogEnabled === true) {
    armWatchdog({
      reason,
      shutdownDurationMs,
      exitCode: exitCode ?? 0,
    });
  }
}
