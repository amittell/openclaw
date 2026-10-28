import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordGatewayRestartTrace } from "./restart-trace.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS = 5_000;

function summarizeHandleCounts(names: readonly string[], label: string): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => `${name}=${count}`);
  return `${label}[${names.length}] ${parts.join(",")}`;
}

/** Constructor name for one active handle, or nothing when the handle is not an object. */
function readHandleConstructorName(handle: unknown): string[] {
  if (typeof handle !== "object" || handle === null) {
    return [];
  }
  // SAFETY: the guard above narrows `handle` to a non-null object; the asserted shape is entirely optional and read through `?.` with an "Unknown" fallback, so a missing constructor name cannot throw.
  const named = handle as { constructor?: { name?: string } };
  return [named.constructor?.name ?? "Unknown"];
}

function summarizeActiveHandlesForZombieReport(): string {
  // SAFETY: widens `process` to two undocumented Node internals; both members are declared optional and every call site below guards with `?.()`, so a runtime without them yields undefined rather than an unchecked call.
  const processWithResourceAccess = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    getActiveResourcesInfo?: () => string[];
  };
  // Prefer constructor names from internal handles for actionable detail, then fall
  // back to getActiveResourcesInfo for newer Node where _getActiveHandles is removed.
  const handles = processWithResourceAccess["_getActiveHandles"]?.();
  if (handles && handles.length > 0) {
    const names = handles.flatMap((handle) => readHandleConstructorName(handle));
    return summarizeHandleCounts(names, "handles");
  }
  const resources = processWithResourceAccess.getActiveResourcesInfo?.();
  if (resources && resources.length > 0) {
    return summarizeHandleCounts(resources, "resources");
  }
  return "no handle/resource detail available";
}

// Force the node process to exit after a clean shutdown if some library held a
// stray handle (HTTP keep-alive, telegram fetch, plugin native handle). Without
// this, the parent supervisor (launchd/systemd) sees the lock dropped but the
// PID never reaps, the HTTP listener stays bound, and the next gateway probe
// returns 200 from the zombie. Tests inject `exitProcess` to avoid killing the
// vitest worker.
export function armGatewayPostShutdownExitWatchdog(opts?: {
  timeoutMs?: number;
  exitProcess?: (code: number) => void;
  reason?: string;
  shutdownDurationMs?: number;
  // Terminal status for the forced exit. Defaults to 0 (clean shutdown). The
  // startup-failure cleanup path passes nonzero so a failure-only supervisor
  // (systemd Restart=on-failure, launchd KeepAlive.SuccessfulExit=false) still
  // relaunches when the watchdog has to force-kill a wedged failed startup.
  exitCode?: number;
}): { cancel: () => void } {
  // Skip in vitest workers: any test that exercises the production close path
  // without mocking this dep would otherwise trip the watchdog and call
  // process.exit() on the worker, killing the whole shard. Tests that want to
  // exercise the watchdog itself inject a mock exitProcess via opts.
  if (process.env.VITEST !== undefined && opts?.exitProcess === undefined) {
    return { cancel: () => {} };
  }
  const timeoutMs = Math.max(
    0,
    Math.floor(opts?.timeoutMs ?? DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS),
  );
  const exit = opts?.exitProcess ?? ((code: number) => process.exit(code));
  const reason = opts?.reason ?? "gateway stopping";
  const shutdownDurationMs = opts?.shutdownDurationMs;
  const exitCode = opts?.exitCode ?? 0;
  const timer = setTimeout(() => {
    const handleSummary = summarizeActiveHandlesForZombieReport();
    shutdownLog.warn(
      `gateway shutdown completed but node process still alive after ${timeoutMs}ms; forcing process.exit(${exitCode}). Likely an unreleased handle (HTTP keep-alive, telegram fetch, plugin native handle). ${handleSummary}`,
    );
    const metrics: Array<readonly [string, string | number]> = [
      ["reason", reason],
      ["forcedExitAfterMs", timeoutMs],
      ["exitCode", exitCode],
      ["handleSummary", handleSummary],
    ];
    if (typeof shutdownDurationMs === "number" && Number.isFinite(shutdownDurationMs)) {
      metrics.push(["shutdownDurationMs", shutdownDurationMs]);
    }
    recordGatewayRestartTrace("gateway.shutdown.zombie_detected", timeoutMs, metrics);
    exit(exitCode);
  }, timeoutMs);
  // unref so this watchdog never blocks a healthy natural exit; we only want
  // it to fire when something else is keeping the loop alive.
  timer.unref?.();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
