// Provides generic retry timing and sleep helpers.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { sleep } from "../utils.js";
import { generateSecureFraction } from "./secure-random.js";

/** Retry timing knobs shared by generic retry runners and channel retry policies. */
export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

/** Metadata emitted before a retry attempt sleeps and reruns the operation. */
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};

/** Retry execution options, including predicates, Retry-After hooks, and retry callbacks. */
export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (info: RetryInfo) => void;
};

const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

function resolveAttemptCount(value: unknown, fallback: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.round(candidate));
}

function resolveRetryDelayMs(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs(value, 0, 0);
}

/** Resolves retry config overrides into clamped timer-safe settings. */
export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = resolveAttemptCount(
    clampNumber(overrides?.attempts, defaults.attempts, 1),
    defaults.attempts,
  );
  const minDelayMs = resolveRetryDelayMs(
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    resolveRetryDelayMs(Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))),
  );
  const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

type JitterMode = "symmetric" | "positive";

function applyJitter(delayMs: number, jitter: number, mode: JitterMode = "symmetric"): number {
  if (jitter <= 0) {
    return delayMs;
  }
  // `symmetric` spreads within ±jitter around the base delay; correct for pure
  // exponential backoff where going slightly early is harmless. `positive`
  // only adds to the base delay; use it when the base delay is already a
  // lower bound the caller must respect (for example a server-supplied
  // Retry-After) so concurrent clients still spread without ever dipping
  // below the caller's floor.
  const fraction = generateSecureFraction();
  const offset = mode === "positive" ? fraction * jitter : (fraction * 2 - 1) * jitter;
  const raw = delayMs * (1 + offset);
  // Rounding choice preserves the mode's contract. `positive` guarantees
  // `delay >= delayMs`, so a non-integer `delayMs` (e.g. retryAfterMs=1.4)
  // must round *up* — plain `Math.round(1.4)=1` would drop the delay below
  // the caller's lower bound and violate the Retry-After invariant the
  // positive branch exists to enforce. Symmetric has no floor contract so
  // it stays on `Math.round`.
  return Math.max(0, mode === "positive" ? Math.ceil(raw) : Math.round(raw));
}

/** Runs an async operation until it succeeds, retry policy stops, or attempts are exhausted. */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = resolveAttemptCount(attemptsOrOptions, DEFAULT_RETRY_CONFIG.attempts);
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = resolveRetryDelayMs(initialDelayMs * 2 ** i);
        await sleep(delay);
      }
    }
    throw toLintErrorObject(lastErr ?? new Error("Retry failed"), "Non-Error thrown");
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const jitter = resolved.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      let delay: number;
      if (hasRetryAfter) {
        // Server-supplied Retry-After is a lower-bound contract with the
        // upstream rate limiter. Honor it independently of maxDelayMs, but
        // cap to the shared timer-safe limit so pathological values cannot
        // overflow Node's setTimeout into an immediate retry.
        const serverFloor = Math.max(Math.min(retryAfterMs, MAX_TIMER_TIMEOUT_MS), minDelayMs);
        delay = applyJitter(serverFloor, jitter, "positive");
        delay = Math.min(Math.max(delay, serverFloor), MAX_TIMER_TIMEOUT_MS);
      } else {
        const baseDelay = minDelayMs * 2 ** (attempt - 1);
        delay = Math.min(baseDelay, maxDelayMs);
        delay = applyJitter(delay, jitter);
        delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);
      }

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw toLintErrorObject(lastErr ?? new Error("Retry failed"), "Non-Error thrown");
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
