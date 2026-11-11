import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createAbortError, racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withTimeout } from "../infra/fs-safe.js";
import type { CommandQueueTaskDeadline } from "../process/command-queue.types.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";

/** Clamp an auth refresh deadline to a safe setTimeout delay. */
export function clampRuntimeAuthRefreshDelayMs(params: {
  refreshAt: number;
  now: number;
  minDelayMs: number;
}): number {
  return resolveSafeTimeoutDelayMs(params.refreshAt - params.now, { minMs: params.minDelayMs });
}

// Hard backstop for one runtime auth step. The run deadline does not always
// bound a step: it is absent when the run has no timeout, unlimited while an
// approval wait pauses the attempt deadline, and 48h away by default. A step
// that never settles (a provider auth hook, keychain/lock wait, or token
// endpoint) would leave the single-flight `refreshInFlight` pending and every
// later turn awaiting it (#93952). The worst legitimate case is two serialized
// in-lock budgets: waiting out a peer's held refresh lock for its full critical
// section (OAUTH_REFRESH_INLOCK_TIMEOUT_MS, 150s) and then running our own
// (another 150s) = 300s. 360s keeps 60s of headroom above that so legitimate
// contention never misreports as a hard timeout.
export const RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS = 360_000;

/**
 * Rejects one auth step at the hard backstop. Unlike the run deadline's
 * AbortError it leaves the auth capability open, so profile rotation and the
 * scheduled retry still run; the abandoned step's late result is discarded.
 */
export class RuntimeAuthDeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Runtime auth operation for ${label} exceeded hard deadline (${timeoutMs}ms)`);
    this.name = "RuntimeAuthDeadlineError";
  }
}

/** Bound caller-owned exchanges; native OAuth owners retain durable refresh settlement. */
export function createRuntimeAuthDeadline(params: {
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
  getDeadline?: () => CommandQueueTaskDeadline | undefined;
}) {
  const authAbort = new AbortController();
  const authSignal = params.signal
    ? AbortSignal.any([params.signal, authAbort.signal])
    : authAbort.signal;
  const timeoutMs = params.timeoutMs;
  const startupDeadline =
    timeoutMs < MAX_TIMER_TIMEOUT_MS
      ? { kind: "bounded" as const, deadlineAtMs: Date.now() + timeoutMs }
      : { kind: "unlimited" as const };
  const withAuthDeadline = <T>(
    step: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const deadline = params.getDeadline?.() ?? startupDeadline;
    const remainingMs =
      deadline.kind === "bounded" ? deadline.deadlineAtMs - Date.now() : undefined;
    const expire = () => {
      const error = createAbortError(
        `${params.provider} ${step} timed out at the run deadline (${timeoutMs}ms). Check the provider's authentication service and retry the run.`,
      );
      authAbort.abort(error);
      return error;
    };
    if (remainingMs !== undefined && remainingMs <= 0) {
      return Promise.reject(expire());
    }
    // One timer: the run deadline when it comes first, otherwise the backstop.
    const runDeadlineFirst =
      remainingMs !== undefined && remainingMs <= RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS;
    return withTimeout(
      racePromiseWithAbortSignal(
        () => operation(authSignal),
        authSignal,
        () =>
          createAbortError(
            `${params.provider} ${step} aborted; authentication capability is closed. Retry the run when authentication is available.`,
          ),
      ),
      runDeadlineFirst ? remainingMs : RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
      {
        createError: runDeadlineFirst
          ? expire
          : () =>
              new RuntimeAuthDeadlineError(
                `${params.provider} ${step}`,
                RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
              ),
      },
    );
  };
  return { run: withAuthDeadline, signal: authSignal, cancel: () => authAbort.abort() };
}
