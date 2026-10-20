import type { AgentHarnessSettledTurnFinalizationResult } from "./types.js";

/** A normally stopped finalizer exhausted its visible answer without failing or using tools. */
export class EmptySettledTurnFinalizationError extends Error {
  constructor(readonly result: AgentHarnessSettledTurnFinalizationResult) {
    super("Settled-turn finalization completed without a visible answer");
    this.name = "EmptySettledTurnFinalizationError";
  }
}

/**
 * A tools-disabled finalizer ended on a tool call that was rejected before
 * execution. The pass did no work, so the host may spend its remaining
 * bounded finalization attempt on another tools-off answer.
 */
export class RejectedToolCallSettledTurnFinalizationError extends Error {
  constructor(readonly toolNames: readonly string[]) {
    super(`Settled-turn finalization returned a tool call: ${toolNames.join(", ")}`);
    this.name = "RejectedToolCallSettledTurnFinalizationError";
  }
}
