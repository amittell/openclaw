import { formatErrorMessage } from "../../infra/errors.js";
import { type ActiveHandlerState, IngressAdoptionLostError } from "./ingress-drain-state.js";
import type { ChannelIngressQueue } from "./ingress-queue.types.js";
import { DEFAULT_INGRESS_RETRY_BASE_MS } from "./ingress-retry-policy.js";

export function clearStallTimer(state: Pick<ActiveHandlerState<unknown, unknown>, "stallTimer">) {
  clearTimeout(state.stallTimer);
  state.stallTimer = undefined;
}

export function clearClaimRefresh(
  state: Pick<ActiveHandlerState<unknown, unknown>, "claimRefreshTimer">,
) {
  clearInterval(state.claimRefreshTimer);
  state.claimRefreshTimer = undefined;
}

/** Watchdog settlement retains its claim until dispatch quiesces or the drain retires. */
function armIngressStallWatchdog<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  {
    now,
    adoptionStallTimeoutMs,
    isStopped,
    settlementObserversRetired,
    applyFailureDisposition,
    log,
    formatError = formatErrorMessage,
  }: {
    now: () => number;
    adoptionStallTimeoutMs: number;
    isStopped: () => boolean;
    settlementObserversRetired: Promise<void>;
    applyFailureDisposition: (
      claim: ActiveHandlerState<TPayload, TMetadata>["claim"],
      error: Error,
      beforeRetryRelease: () => Promise<void>,
    ) => Promise<void>;
    log: (message: string) => void;
    formatError?: (error: unknown) => string;
  },
): ReturnType<typeof setTimeout> {
  const waitForQuiescenceOrStop = async (task: Promise<void>): Promise<void> => {
    if (isStopped()) {
      throw new IngressAdoptionLostError("aborted");
    }
    // Abort and direct disposal both retire this watchdog-owned wait. Terminal
    // callbacks retain their separate late-settlement contract.
    await Promise.race([
      task,
      settlementObserversRetired.then(() => {
        throw new IngressAdoptionLostError("aborted");
      }),
    ]);
    if (isStopped()) {
      throw new IngressAdoptionLostError("aborted");
    }
  };

  const settleStalledClaim = async (timeoutError: Error, displayId: string) => {
    while (!isStopped() && state.phase !== "settled") {
      try {
        await state.settleOnce(async () => {
          await applyFailureDisposition(
            state.claim,
            timeoutError,
            async () => await waitForQuiescenceOrStop(state.quiescence.task),
          );
        });
      } catch (err) {
        if (isStopped()) {
          return;
        }
        log(
          `ingress drain: failed to settle stalled event ${displayId}; holding claim and retrying: ${formatError(err)}`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DEFAULT_INGRESS_RETRY_BASE_MS);
          timer.unref?.();
        });
        continue;
      }
      return;
    }
  };

  return setTimeout(() => {
    // Pre-adoption only (dispatching OR deferred). Timer is not cleared by deferral.
    if (state.phase !== "dispatching" && state.phase !== "deferred") {
      return;
    }
    const ageMs = now() - state.startedAt;
    const displayId = state.eventId.replace(/^0+(?=\d)/, "") || state.eventId;
    const message = `Channel ingress claim→adoption stalled for event ${displayId} on lane ${state.laneKey} after ${ageMs}ms; applying retry policy (handler-timeout).`;
    const timeoutError = new Error(message);
    // Closed guillotine flag — catch must not string-sniff errors.
    state.guillotined = true;
    state.stallTimer = undefined;
    log(message);
    // Install settlement before aborting so synchronous terminal callbacks
    // can join the same durable release instead of returning early.
    const settlementTask = settleStalledClaim(timeoutError, displayId);
    state.stallSettlementTask = settlementTask;
    try {
      state.abortController.abort(timeoutError);
    } catch {
      // AbortController.abort is not fallible in practice.
    }
  }, adoptionStallTimeoutMs);
}

/**
 * Per-claim timers for one drain: the claim→adoption stall watchdog and the
 * claim-lease refresh that guillotines a claim whose lease another owner
 * reclaimed. Split out of ./ingress-drain.ts to keep that module within the
 * max-lines budget.
 */
export function createIngressClaimTimers<TPayload, TMetadata>({
  queue,
  now,
  claimLeaseMs,
  adoptionStallTimeoutMs,
  isStopped,
  settlementObserversRetired,
  applyFailureDisposition,
  log,
  formatError,
}: {
  queue: Pick<ChannelIngressQueue<unknown>, "refreshClaim">;
  now: () => number;
  claimLeaseMs: number;
  adoptionStallTimeoutMs: number;
  isStopped: () => boolean;
  settlementObserversRetired: Promise<void>;
  applyFailureDisposition: (
    claim: ActiveHandlerState<TPayload, TMetadata>["claim"],
    error: Error,
    beforeRetryRelease: () => Promise<void>,
  ) => Promise<void>;
  log: (message: string) => void;
  formatError: (error: unknown) => string;
}) {
  const markLeaseReclaimed = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    // Guillotine-style closed flag: late onAdopted throws IngressAdoptionLostError.
    // Do not release/fail — another owner holds the claim token.
    if (state.phase === "settled") {
      return;
    }
    state.guillotined = true;
    clearStallTimer(state);
    clearClaimRefresh(state);
    state.abortController.abort(new Error("ingress claim lease reclaimed"));
  };

  const armClaimRefresh = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearClaimRefresh(state);
    // Keep lease alive until tombstone commits (includes complete-retry wedge).
    const intervalMs = Math.max(1, Math.floor(claimLeaseMs / 3));
    state.claimRefreshTimer = setInterval(() => {
      if (state.phase === "settled") {
        clearClaimRefresh(state);
        return;
      }
      if (!queue.refreshClaim) {
        return;
      }
      void queue
        .refreshClaim(state.claim, { refreshedAt: now() })
        .then((refreshed) => {
          // false = claim-token fence rejected (lease reclaimed by another owner).
          if (!refreshed) {
            markLeaseReclaimed(state);
          }
        })
        .catch((err: unknown) => {
          log(
            `ingress drain: claim refresh failed for event ${state.claim.id}; holding claim: ${formatError(err)}`,
          );
        });
    }, intervalMs);
    state.claimRefreshTimer.unref?.();
  };

  const armStallWatchdog = (state: ActiveHandlerState<TPayload, TMetadata>) => {
    clearStallTimer(state);
    state.stallTimer = armIngressStallWatchdog(state, {
      now,
      adoptionStallTimeoutMs,
      isStopped,
      settlementObserversRetired,
      applyFailureDisposition,
      log,
      formatError,
    });
    state.stallTimer.unref?.();
  };

  return { armClaimRefresh, armStallWatchdog };
}
