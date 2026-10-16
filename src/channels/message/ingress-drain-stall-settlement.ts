import type {
  ActiveHandlerState,
  ChannelIngressDrainDispatchResult,
} from "./ingress-drain-state.js";

type StallSettlementState = Pick<
  ActiveHandlerState<unknown, unknown>,
  "phase" | "quiescence" | "stallSettlementTask"
>;

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
    noteDispatchResult,
    finishDeferredAfterOwnershipLoss,
    hasPending,
    waitFor,
  };
}
