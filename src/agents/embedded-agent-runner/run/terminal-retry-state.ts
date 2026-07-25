export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;
// Bounded to one continuation per run so a model that refuses to use the
// message tool cannot ping-pong the terminal loop.
export const MAX_SILENT_STOP_NUDGES = 1;

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  silentStopNudges: number;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    silentStopNudges: 0,
  };
}
