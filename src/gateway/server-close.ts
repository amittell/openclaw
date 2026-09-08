// Gateway shutdown and restart close orchestration.
// Coordinates hooks, drains, sockets, sidecars, plugins, and runtime cleanup.
import type { Server as HttpServer } from "node:http";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { WebSocketServer } from "ws";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../acp/control-plane/manager.lifecycle.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-tools.js";
import { disposeRegisteredAgentHarnesses } from "../agents/harness/registry.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { closePluginStateDatabase } from "../plugin-state/plugin-state-store.js";
import { clearActivePluginRegistry } from "../plugins/runtime.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  collectGatewayProcessMemoryUsageMb,
  markGatewayRestartTrace,
  measureGatewayRestartTrace,
  recordGatewayRestartTrace,
} from "./restart-trace.js";
// Shutdown lifecycle state lives in `gateway-shutdown-state.ts` so callers that
// only need the running / shutting-down distinction (gateway startup, HTTP probe
// handler) do not pull in this close module's dependency graph. Re-exported below
// for source compatibility with prior in-tree callers.
import {
  isGatewayShuttingDown,
  markGatewayShuttingDown,
  resetGatewayShuttingDownForTest,
  resetGatewayShuttingDownState,
} from "./gateway-shutdown-state.js";
import type { ChatRunState } from "./server-chat-state.js";
import { WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import type { MediaCleanupStopResult } from "./server-media-cleanup-lifecycle.js";
import { clearSessionTypingState } from "./server-methods/session-typing-state.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { prepareGatewayRunShutdown, type GatewayRunShutdownParams } from "./server-run-shutdown.js";
import type { GatewayMaintenanceHandles } from "./server-runtime-services.js";
import {
  createGatewayShutdownTimeout as createTimeoutRace,
  recordGatewayShutdownWarning as recordShutdownWarning,
  resolveGatewayShutdownNotice,
} from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS = 5_000;
const GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS = 10_000;
const ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_FORCE_CONTINUE_MS = 250;
const HTTP_CLOSE_GRACE_MS = 1_000;
const HTTP_CLOSE_FORCE_WAIT_MS = 5_000;
const MCP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const LSP_RUNTIME_CLOSE_GRACE_MS = 5_000;
const EMBEDDING_PROVIDER_CLOSE_GRACE_MS = 5_000;
const AGENT_HARNESS_CLOSE_GRACE_MS = 5_000;
const DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS = 5_000;
const POST_SHUTDOWN_EXIT_TIMEOUT_ENV = "OPENCLAW_GATEWAY_POST_SHUTDOWN_EXIT_TIMEOUT_MS";

export {
  isGatewayShuttingDown,
  markGatewayShuttingDown,
  resetGatewayShuttingDownForTest,
  resetGatewayShuttingDownState,
};

function resolvePostShutdownExitTimeoutMs(): number {
  const raw = process.env[POST_SHUTDOWN_EXIT_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    // The override is a public operator contract; a typo silently reverting
    // to 5s would make wedge diagnosis misleading, so surface the fallback.
    shutdownLog.warn(
      `${POST_SHUTDOWN_EXIT_TIMEOUT_ENV}="${raw}" is not a strict positive integer; using default ${DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS}ms`,
    );
    return DEFAULT_POST_SHUTDOWN_EXIT_TIMEOUT_MS;
  }
  return parsed;
}

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
    const names = handles.flatMap((handle) =>
      typeof handle === "object" && handle !== null
        ? // SAFETY: `handle` is `unknown` narrowed to a non-null object by the guard above; the asserted shape is entirely optional and read through `?.` with an "Unknown" fallback, so a missing constructor name cannot throw.
          [(handle as { constructor?: { name?: string } }).constructor?.name ?? "Unknown"]
        : [],
    );
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
  const timeoutMs = Math.max(0, Math.floor(opts?.timeoutMs ?? resolvePostShutdownExitTimeoutMs()));
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

type ShutdownResult = {
  durationMs: number;
  warnings: string[];
};

function createCloseStepTimer(reason: string) {
  return <T>(name: string, run: () => Promise<T> | T) => {
    markGatewayRestartTrace(`restart.close.${name}.begin`);
    return measureGatewayRestartTrace(`restart.close.${name}`, run, [["reason", reason]]);
  };
}

/** Run one shutdown step and record a warning instead of aborting the whole close. */
async function shutdownStep(
  name: string,
  fn: () => Promise<void> | void,
  warnings: string[],
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${name}: ${detail}`);
    recordShutdownWarning(warnings, name);
    return false;
  }
}

async function triggerGatewayLifecycleHookWithTimeout(params: {
  event: ReturnType<typeof createInternalHookEvent>;
  hookName: "gateway:shutdown" | "gateway:pre-restart";
  timeoutMs: number;
}): Promise<"completed" | "timeout"> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const hookPromise = triggerInternalHook(params.event);
  void hookPromise.catch(() => undefined);
  try {
    const result = await Promise.race([
      hookPromise.then(() => "completed" as const),
      new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (result === "timeout") {
      shutdownLog.warn(
        `${params.hookName} hook timed out after ${params.timeoutMs}ms; continuing shutdown`,
      );
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function disposeRuntimeWithShutdownGrace(params: {
  label:
    | "plugin-services"
    | "agent-harnesses"
    | "bundle-mcp"
    | "bundle-lsp"
    | "embedding-providers";
  dispose: () => Promise<void>;
  graceMs: number;
  warnings: string[];
}): Promise<void> {
  const disposePromise = Promise.resolve()
    .then(params.dispose)
    .catch((err: unknown) => {
      shutdownLog.warn(`${params.label} runtime disposal failed during shutdown: ${String(err)}`);
      recordShutdownWarning(params.warnings, params.label);
    });
  const disposeTimeout = createTimeoutRace(params.graceMs, () => {
    shutdownLog.warn(
      `${params.label} runtime disposal exceeded ${params.graceMs}ms; continuing shutdown`,
    );
    recordShutdownWarning(params.warnings, params.label);
  });
  await Promise.race([disposePromise, disposeTimeout.promise]);
  disposeTimeout.clear();
}

export async function runGatewayClosePrelude(params: {
  stopDiagnostics?: () => void;
  clearSkillsRefreshTimer?: () => void;
  skillsChangeUnsub?: () => void | Promise<void>;
  disposeAuthRateLimiter?: () => void;
  disposeBrowserAuthRateLimiter: () => void;
  stopChannelHealthMonitor?: () => Promise<void>;
  stopReadinessEventLoopHealth?: () => void;
  closeMcpServer?: () => Promise<void>;
}): Promise<void> {
  params.stopDiagnostics?.();
  params.clearSkillsRefreshTimer?.();
  await params.skillsChangeUnsub?.();
  params.disposeAuthRateLimiter?.();
  params.disposeBrowserAuthRateLimiter();
  await params.stopChannelHealthMonitor?.();
  params.stopReadinessEventLoopHealth?.();
  await params.closeMcpServer?.().catch(() => {});
}

function isServerNotRunningError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING",
  );
}

async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  const timeout = createTimeoutRace(params.timeoutMs, () => false as const);
  try {
    return await Promise.race([
      params.closePromise.then(
        () => true,
        (err: unknown) => {
          throw err;
        },
      ),
      timeout.promise,
    ]).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      shutdownLog.warn(`${params.label}: ${detail}`);
      recordShutdownWarning(params.warnings, params.label);
      return true;
    });
  } finally {
    timeout.clear();
  }
}

async function closeHttpListener(params: {
  server: HttpServer;
  label: string;
  warnings: string[];
}): Promise<void> {
  const { server, label, warnings } = params;
  server.closeIdleConnections?.();
  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (!err || isServerNotRunningError(err)) {
        resolve();
        return;
      }
      reject(err);
    });
  });
  void closePromise.catch(() => undefined);
  const closedWithinGrace = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_GRACE_MS,
    label,
    warnings,
  });
  if (closedWithinGrace) {
    return;
  }
  shutdownLog.warn(
    `${label} close exceeded ${HTTP_CLOSE_GRACE_MS}ms; forcing connection shutdown and waiting for close`,
  );
  recordShutdownWarning(warnings, label);
  server.closeAllConnections?.();
  const closedAfterForce = await waitForHttpClose({
    closePromise,
    timeoutMs: HTTP_CLOSE_FORCE_WAIT_MS,
    label,
    warnings,
  });
  if (!closedAfterForce) {
    throw new Error(
      `${label} close still pending after forced connection shutdown (${HTTP_CLOSE_FORCE_WAIT_MS}ms)`,
    );
  }
}

export type GatewayCloseParams = {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  clearSecretsRuntimeSnapshot?: (() => void) | null;
  channelIds?: readonly ChannelId[];
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  disposeSessionMcpRuntimes?: () => Promise<void>;
  disposeBundleLspRuntimes?: () => Promise<void>;
  disposeAllBundleLspRuntimes: () => Promise<void>;
  drainRetainedOpenAiEmbeddingProviders: () => Promise<void>;
  stopGmailWatcher: () => Promise<void>;
  disposeAllCodeModeRuns: () => Promise<void> | void;
  closeProviderTransportDispatcherPool: () => Promise<void>;
  cron: { stop: () => void; stopAndDrain?: () => Promise<void> };
  heartbeatRunner: HeartbeatRunner;
  stopTaskRegistryMaintenance?: (() => Promise<void> | void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  maintenance: GatewayMaintenanceHandles | null;
  stopMediaCleanup: () => Promise<MediaCleanupStopResult>;
  agentUnsub: (() => Promise<void> | void) | null;
  heartbeatUnsub: (() => void) | null;
  transcriptUnsub: (() => void) | null;
  lifecycleUnsub: (() => void) | null;
  taskUnsub: (() => void) | null;
  clients: Set<{
    connectionKind?: "gateway" | "worker";
    socket: { close: (code: number, reason: string) => void };
  }>;
  finishRequestEntries?: () => Promise<void>;
  wss?: WebSocketServer;
  httpServer?: HttpServer;
  httpServers?: HttpServer[];
  drainActiveSessionsForShutdown?: (params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
  }) => Promise<{ emittedSessionIds: string[]; timedOut: boolean }>;
  chatRunState: ChatRunState;
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

export type GatewayClosePrepareParams = GatewayRunShutdownParams & {
  updateCheckStop?: (() => Promise<void> | void) | null;
  configReloader: { stop: () => Promise<void> };
  getPendingReplyCount: () => number;
};

export type GatewayClosePreparation = {
  start: number;
  // Terminal status the post-shutdown watchdog forces if the process wedges.
  // Defaults to 0; startup-failure cleanup passes nonzero so a failure-only
  // supervisor still relaunches a force-killed failed startup. Carried here
  // because completeGatewayClose takes the preparation, not the close options.
  postShutdownExitCode?: number;
  notice: ReturnType<typeof resolveGatewayShutdownNotice>;
  warnings: string[];
};

export async function prepareGatewayClose(
  params: GatewayClosePrepareParams,
  opts?: GatewayCloseOptions,
): Promise<GatewayClosePreparation> {
  const start = Date.now();
  const warnings: string[] = [];
  const notice = resolveGatewayShutdownNotice(opts);
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  const measureCloseStep = createCloseStepTimer(reason);
  // Flip the shutdown flag before any await so /healthz starts returning 503
  // immediately. Lock-recovery preflight uses that 503 to tell a live gateway
  // from a zombie that still holds the port.
  markGatewayShuttingDown();
  // Fence async session-state writes before the first awaited shutdown step.
  fenceSessionSuspensionWritesForGatewayShutdown();
  // Debug-level: the signal handler already announced the stop/restart at
  // info, and the completion line below reports duration and outcome.
  shutdownLog.debug(`shutdown started: ${reason}`);

  await shutdownStep("update-check", () => params.updateCheckStop?.(), warnings);
  await measureCloseStep("config-reloader", () =>
    shutdownStep("config-reloader", () => params.configReloader.stop(), warnings),
  );
  await measureCloseStep("gateway-shutdown-hook", () =>
    shutdownStep(
      "gateway:shutdown",
      async () => {
        const shutdownEvent = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {
          reason,
          restartExpectedMs,
        });
        const result = await triggerGatewayLifecycleHookWithTimeout({
          event: shutdownEvent,
          hookName: "gateway:shutdown",
          timeoutMs: GATEWAY_SHUTDOWN_HOOK_TIMEOUT_MS,
        });
        if (result === "timeout") {
          recordShutdownWarning(warnings, "gateway:shutdown");
        }
      },
      warnings,
    ),
  );
  if (restartExpectedMs !== null) {
    await measureCloseStep("gateway-pre-restart-hook", () =>
      shutdownStep(
        "gateway:pre-restart",
        async () => {
          const preRestartEvent = createInternalHookEvent(
            "gateway",
            "pre-restart",
            "gateway:pre-restart",
            {
              reason,
              restartExpectedMs,
            },
          );
          const result = await triggerGatewayLifecycleHookWithTimeout({
            event: preRestartEvent,
            hookName: "gateway:pre-restart",
            timeoutMs: GATEWAY_PRE_RESTART_HOOK_TIMEOUT_MS,
          });
          if (result === "timeout") {
            recordShutdownWarning(warnings, "gateway:pre-restart");
          }
        },
        warnings,
      ),
    );
  }
  const drainTimeoutMs =
    typeof opts?.drainTimeoutMs === "number" && Number.isFinite(opts.drainTimeoutMs)
      ? Math.max(0, Math.floor(opts.drainTimeoutMs))
      : 0;
  await measureCloseStep("reply-drain", () =>
    prepareGatewayRunShutdown({
      ...params,
      restart: restartExpectedMs !== null,
      timeoutMs: drainTimeoutMs,
      warnings,
    }),
  );
  return { start, notice, warnings, postShutdownExitCode: opts?.postShutdownExitCode };
}

export async function completeGatewayClose(
  params: GatewayCloseParams,
  preparation: GatewayClosePreparation,
): Promise<ShutdownResult> {
  const { start, notice, warnings } = preparation;
  const { reason } = notice;
  const restartExpectedMs = notice.restartExpectedMs ?? null;
  let pluginServicesCleanup: Promise<void> | undefined;
  let mediaCleanupStopResult: MediaCleanupStopResult = "timed-out";
  const measureCloseStep = createCloseStepTimer(reason);
  try {
    if (params.drainActiveSessionsForShutdown) {
      await measureCloseStep("session-end-drain", () =>
        shutdownStep(
          "session-end-drain",
          async () => {
            const drainReason: "shutdown" | "restart" =
              restartExpectedMs !== null ? "restart" : "shutdown";
            const result = await params.drainActiveSessionsForShutdown!({
              reason: drainReason,
              totalTimeoutMs: ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS,
            });
            if (result.timedOut) {
              shutdownLog.warn(
                `session-end-drain timed out after ${ACTIVE_SESSIONS_SHUTDOWN_DRAIN_TIMEOUT_MS}ms after ${result.emittedSessionIds.length} sessions; continuing shutdown`,
              );
              recordShutdownWarning(warnings, "session-end-drain");
            }
          },
          warnings,
        ),
      );
    }
    if (params.bonjourStop) {
      await shutdownStep("bonjour", () => params.bonjourStop!(), warnings);
    }
    // ACPX owns agent-process cleanup, so plugin teardown must not overtake
    // the manager drain even when cancellation and handle close are slow.
    await measureCloseStep("acp-session-manager", () =>
      shutdownStep(
        "acp-session-manager",
        () => disposeAcpSessionManagerInstance(getAcpSessionManager(), "gateway-shutdown"),
        warnings,
      ),
    );
    if (params.pluginServices) {
      const cleanup = Promise.resolve().then(() => params.pluginServices!.stop());
      pluginServicesCleanup = cleanup;
      await measureCloseStep("plugin-services", () =>
        // A stalled plugin must not prevent later runtime and child-process cleanup.
        disposeRuntimeWithShutdownGrace({
          label: "plugin-services",
          dispose: () => cleanup,
          graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
      );
    }
    await measureCloseStep("channels", async () => {
      const channelIds = params.channelIds ?? listChannelPlugins().map((plugin) => plugin.id);
      for (const channelId of channelIds) {
        await shutdownStep(`channel/${channelId}`, () => params.stopChannel(channelId), warnings);
      }
    });
    await shutdownStep("code-mode-runs", () => params.disposeAllCodeModeRuns(), warnings);
    await disposeRuntimeWithShutdownGrace({
      label: "agent-harnesses",
      dispose: disposeRegisteredAgentHarnesses,
      graceMs: AGENT_HARNESS_CLOSE_GRACE_MS,
      warnings,
    });
    await shutdownStep("ai-session-resources", () => cleanupSessionResources(), warnings);
    await shutdownStep(
      "provider-transport-dispatchers",
      () => params.closeProviderTransportDispatcherPool(),
      warnings,
    );
    await measureCloseStep("bundle-runtimes", async () => {
      await Promise.all([
        disposeRuntimeWithShutdownGrace({
          label: "bundle-mcp",
          dispose: params.disposeSessionMcpRuntimes ?? disposeAllSessionMcpRuntimes,
          graceMs: MCP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
        disposeRuntimeWithShutdownGrace({
          label: "bundle-lsp",
          dispose: params.disposeBundleLspRuntimes ?? params.disposeAllBundleLspRuntimes,
          graceMs: LSP_RUNTIME_CLOSE_GRACE_MS,
          warnings,
        }),
      ]);
    });
    try {
      mediaCleanupStopResult = await params.stopMediaCleanup();
    } catch (err) {
      shutdownLog.warn(`media-cleanup: ${err instanceof Error ? err.message : String(err)}`);
      recordShutdownWarning(warnings, "media-cleanup");
    }
    if (mediaCleanupStopResult !== "drained") {
      // Timed-out cleanup still owns shared SQLite. Keep the process store open
      // so late completion cannot resume against a database torn down by shutdown.
      recordShutdownWarning(warnings, "media-cleanup");
    }
    await measureCloseStep("gmail-watcher", () =>
      shutdownStep("gmail-watcher", () => params.stopGmailWatcher(), warnings),
    );
    await shutdownStep(
      "cron",
      () => (params.cron.stopAndDrain ? params.cron.stopAndDrain() : params.cron.stop()),
      warnings,
    );
    await shutdownStep("heartbeat-runner", () => params.heartbeatRunner.stop(), warnings);
    await shutdownStep(
      "task-registry-maintenance",
      () => params.stopTaskRegistryMaintenance?.(),
      warnings,
    );
    for (const timer of params.nodePresenceTimers.values()) {
      clearInterval(timer);
    }
    params.nodePresenceTimers.clear();
    if (params.maintenance) {
      clearInterval(params.maintenance.tickInterval);
      clearInterval(params.maintenance.healthInterval);
      clearInterval(params.maintenance.dedupeCleanup);
      clearInterval(params.maintenance.worktreeCleanup);
      params.maintenance.skillUsageCleanup();
    }
    if (params.agentUnsub) {
      await shutdownStep("agent-unsub", () => params.agentUnsub!(), warnings);
    }
    if (params.heartbeatUnsub) {
      await shutdownStep("heartbeat-unsub", () => params.heartbeatUnsub!(), warnings);
    }
    if (params.transcriptUnsub) {
      await shutdownStep("transcript-unsub", () => params.transcriptUnsub!(), warnings);
    }
    if (params.lifecycleUnsub) {
      await shutdownStep("lifecycle-unsub", () => params.lifecycleUnsub!(), warnings);
    }
    if (params.taskUnsub) {
      await shutdownStep("task-unsub", () => params.taskUnsub!(), warnings);
    }
    params.chatRunState.clear();
    let clientCloseFailures = 0;
    for (const c of params.clients) {
      try {
        c.socket.close(
          1012,
          c.connectionKind === "worker" ? "gateway-shutdown" : "service restart",
        );
      } catch {
        clientCloseFailures++;
      }
    }
    if (clientCloseFailures > 0) {
      shutdownLog.warn(`failed to close ${clientCloseFailures} WebSocket client(s)`);
      recordShutdownWarning(warnings, "ws-clients");
    }
    params.clients.clear();
    if (params.wss) {
      await measureCloseStep("websocket-server", async () => {
        const wsClients = params.wss?.clients ?? new Set();
        const closePromise = new Promise<void>((resolve) => {
          params.wss?.close(() => resolve());
        });
        const websocketGraceTimeout = createTimeoutRace(
          WEBSOCKET_CLOSE_GRACE_MS,
          () => false as const,
        );
        const closedWithinGrace = await Promise.race([
          closePromise.then(() => true),
          websocketGraceTimeout.promise,
        ]);
        websocketGraceTimeout.clear();
        if (!closedWithinGrace) {
          shutdownLog.warn(
            `websocket server close exceeded ${WEBSOCKET_CLOSE_GRACE_MS}ms; forcing shutdown continuation with ${wsClients.size} tracked client(s)`,
          );
          recordShutdownWarning(warnings, "websocket-server");
          for (const client of wsClients) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }
          const websocketForceTimeout = createTimeoutRace(WEBSOCKET_CLOSE_FORCE_CONTINUE_MS, () => {
            shutdownLog.warn(
              `websocket server close still pending after ${WEBSOCKET_CLOSE_FORCE_CONTINUE_MS}ms force window; continuing shutdown`,
            );
          });
          await Promise.race([closePromise, websocketForceTimeout.promise]);
          websocketForceTimeout.clear();
        }
      });
    }
    // Node cleanup replies remain admissible until sockets close. Join their
    // uncancellable preparation before releasing the remaining process state.
    await params.finishRequestEntries?.();
    clearSessionTypingState();
    const transportServers =
      params.httpServers && params.httpServers.length > 0
        ? params.httpServers
        : params.httpServer
          ? [params.httpServer]
          : [];
    try {
      if (transportServers.length > 0) {
        await measureCloseStep("http-server", async () => {
          const results = await Promise.allSettled(
            transportServers.map((server, index) =>
              closeHttpListener({
                server,
                label: transportServers.length > 1 ? `http-server[${index}]` : "http-server",
                warnings,
              }),
            ),
          );
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure) {
            throw failure.reason;
          }
        });
      }
    } finally {
      // The foreground Tailscale session owns the route, so closing its claim
      // releases the ephemeral backend before this lifecycle is forgotten.
      if (params.tailscaleCleanup) {
        await shutdownStep("tailscale", () => params.tailscaleCleanup!(), warnings);
      }
    }
    await disposeRuntimeWithShutdownGrace({
      label: "embedding-providers",
      dispose: params.drainRetainedOpenAiEmbeddingProviders,
      graceMs: EMBEDDING_PROVIDER_CLOSE_GRACE_MS,
      warnings,
    });
  } finally {
    // Grace lets independent teardown advance; pending plugin cleanup still owns
    // shared state. Its rejection was reported by the disposal policy above.
    await pluginServicesCleanup?.catch(() => {});
    await params.finishRequestEntries?.();
    if (mediaCleanupStopResult === "drained") {
      await shutdownStep("plugin-state-store", () => closePluginStateDatabase(), warnings);
    }
    await shutdownStep("plugin-host-registry", clearActivePluginRegistry, warnings);
    // Channel and plugin teardown still resolve account credentials. Keep the
    // active snapshot until every teardown owner is done, then always scrub it.
    try {
      // Plugin cleanup may still read ambient slots. A failed owner drain must
      // stop restart so the next lifecycle cannot reuse incomplete shutdown.
      await drainGlobalSingletonLifecycleState(restartExpectedMs === null ? "close" : "restart");
    } finally {
      try {
        params.clearSecretsRuntimeSnapshot?.();
      } catch {
        /* ignore */
      }
    }
  }

  const durationMs = Date.now() - start;
  if (warnings.length > 0) {
    shutdownLog.warn(`shutdown completed in ${durationMs}ms with warnings: ${warnings.join(", ")}`);
  } else {
    shutdownLog.info(`shutdown completed cleanly in ${durationMs}ms`);
  }

  recordGatewayRestartTrace("restart.close.total", durationMs, [
    ["reason", reason],
    ["restartExpectedMs", restartExpectedMs ?? "none"],
    ...collectGatewayProcessMemoryUsageMb(),
  ]);
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
      shutdownDurationMs: durationMs,
      exitCode: preparation.postShutdownExitCode ?? 0,
    });
  }
  return { durationMs, warnings };
}
