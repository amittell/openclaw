export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 3;
// Bounded to one continuation per run so a model that refuses to use the
// message tool cannot ping-pong the terminal loop.
export const MAX_SILENT_STOP_NUDGES = 1;

export type CodeModeRecoveryCandidate = {
  blockedActionKeys?: readonly string[];
};

export type CodeModeRecoveryState =
  | { kind: "idle" }
  | {
      kind: "inspect";
      phase: "read-required" | "ready";
      blockedActionKeys?: readonly string[];
    }
  | {
      kind: "resume";
      blockedActionKeys: ReadonlySet<string>;
      mutationAttempt: "available" | "reserved" | "consumed";
    };

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  codeModeRecovery: CodeModeRecoveryState;
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
    codeModeRecovery: { kind: "idle" },
    silentStopNudges: 0,
  };
}
