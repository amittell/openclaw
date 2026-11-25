import type {
  ActiveHandlerState,
  ChannelIngressDrainDispatchResult,
} from "./ingress-drain-state.js";
import { clearStallTimer } from "./ingress-drain-watchdog.js";
import type { ChannelIngressQueueClaim } from "./ingress-queue.types.js";

type StallSettlementState = Pick<
  ActiveHandlerState<unknown, unknown>,
  "phase" | "quiescence" | "stallSettlementTask"
>;
type OwnedStallSettlementState = StallSettlementState &
  Pick<ActiveHandlerState<unknown, unknown>, "guillotined" | "superseded">;
type DispatchOutcome = ChannelIngressDrainDispatchResult | void;

/**
 * Per-drain coordination between dispatch quiescence and watchdog-owned stall
 * settlements: retiring the drain releases watchdog waits, terminal callbacks
 * that lost ownership join the settlement that now owns the claim, and the
 * monitor can observe or await settlements still in flight.
 */
export function createIngressStallSettlements() {
  let retire!: () => void;
  const retired = new Promise<void>((resolve) => {
    retire = resolve;
  });

  // The dispatcher's own deferral or retryable failure decides whether dispatch
  // quiescence still waits on a later terminal callback.
  const noteDispatchResult = (
    state: StallSettlementState,
    result: ChannelIngressDrainDispatchResult | void,
  ) => {
    if (result?.kind === "deferred") {
      state.quiescence.markDeferred();
    } else if (result?.kind === "failed-retryable") {
      state.quiescence.markDeferredSettled();
    }
  };

  const finishDeferredAfterOwnershipLoss = async (state: StallSettlementState) => {
    state.quiescence.markDeferredSettled();
    // A terminal callback normally runs after dispatch returned deferred. If a
    // dispatcher invokes it while unwinding, returning lets that dispatcher
    // quiesce first instead of making both sides wait on each other.
    if (state.quiescence.isDispatchSettled()) {
      await state.stallSettlementTask?.catch(() => undefined);
    }
  };

  // The callback itself is gone before any result settlement joins the watchdog-owned
  // release; deferred participation remains separate.
  const runDispatch = async (
    state: StallSettlementState,
    dispatch: () => Promise<DispatchOutcome> | DispatchOutcome,
  ): Promise<DispatchOutcome> => {
    try {
      const result = await dispatch();
      noteDispatchResult(state, result);
      return result;
    } catch (err) {
      state.quiescence.markDeferredSettled();
      throw err;
    } finally {
      state.quiescence.markDispatchSettled();
    }
  };

  // A terminal failure callback that lost ownership joins the settlement that now owns the
  // claim; otherwise it settles through the retry owner.
  const settleFailed = async (state: OwnedStallSettlementState, settle: () => Promise<void>) => {
    if (state.phase !== "dispatching" && state.phase !== "deferred") {
      return;
    }
    if (state.guillotined || state.superseded) {
      await finishDeferredAfterOwnershipLoss(state);
      return;
    }
    state.quiescence.markDeferredSettled();
    // Keep recovery armed until disposition commits; removeActive clears it after success.
    await settle();
  };

  const hasPending = (states: Iterable<StallSettlementState>) =>
    [...states].some(
      (state) => state.stallSettlementTask !== undefined && state.phase !== "settled",
    );

  const waitFor = async (states: Iterable<StallSettlementState>) => {
    const tasks = [...states].flatMap((state) =>
      state.stallSettlementTask ? [state.stallSettlementTask] : [],
    );
    await Promise.race([Promise.allSettled(tasks), retired]);
  };

  return {
    retired,
    retire,
    runDispatch,
    settleFailed,
    finishDeferredAfterOwnershipLoss,
    hasPending,
    waitFor,
  };
}

/**
 * Cancel/abandon release for a claim that was never adopted; a callback that
 * lost ownership joins the settlement that now owns the claim instead. Split
 * out of ./ingress-drain.ts to keep that module within the max-lines budget.
 */
export function createIngressUnadoptedRelease<TPayload, TMetadata>(
  stallSettlements: Pick<
    ReturnType<typeof createIngressStallSettlements>,
    "finishDeferredAfterOwnershipLoss"
  >,
  releaseClaim: (
    claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    releaseOptions: { lastError?: string; recordAttempt?: boolean },
  ) => Promise<unknown>,
) {
  return async (
    state: ActiveHandlerState<TPayload, TMetadata>,
    releaseOptions: { lastError?: string; recordAttempt?: boolean },
  ) => {
    if (state.phase !== "deferred" && state.phase !== "dispatching") {
      return;
    }
    if (state.guillotined || state.superseded) {
      await stallSettlements.finishDeferredAfterOwnershipLoss(state);
      return;
    }
    clearStallTimer(state);
    await state
      .settleOnce(async () => {
        await releaseClaim(state.claim, releaseOptions);
      })
      .catch(() => undefined);
  };
}
