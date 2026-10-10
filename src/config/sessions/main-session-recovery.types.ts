/**
 * Typed cause of one main-session interruption, persisted so the resume notice can
 * distinguish a genuine gateway restart from an in-process abort (e.g. a
 * context-overflow retry). Pre-upgrade state predates this field and reads as
 * unknown; unknown cause must render neutral wording and must not re-dispatch.
 */
export type MainRestartRecoveryCause = "gateway_restart" | "unknown";

export type MainRestartRecoveryState = {
  /** Stable identity for one interrupted episode; prevents clear-and-rewedge ABA matches. */
  cycleId: string;
  /**
   * Typed cause of the interruption that opened this cycle. Only a genuine
   * gateway restart sets "gateway_restart"; in-process aborts leave it unset
   * (unknown). Authoritative for the resume notice wording.
   */
  cause?: MainRestartRecoveryCause;
  /** Monotonic identity for observations within the current recovery cycle. */
  revision: number;
  /** Attempts charged when their reservation is persisted, before dispatch. */
  chargedAttempts: number;
  /** Last attempt observed starting a backend turn; later startup failures get a fresh budget. */
  startedAttempt?: number;
  /** Private safe token for one recovered outer turn; raw identity refs never enter session state. */
  executionIdentity?: {
    tokenVersion: 1;
    contextId: string;
    executionId: string;
    runId: string;
    createdAt: number;
  };
  reservation?: {
    runId: string;
    attempt: number;
    lifecycleGeneration: string;
    /** Cause carried from the cycle so an in-flight reservation stays attributable. */
    cause?: MainRestartRecoveryCause;
  };
  foregroundClaims?: {
    lifecycleGeneration: string;
    tokens: string[];
    /** Run identity for claims that have crossed the actual agent-run boundary. */
    runIdsByClaimId?: Record<string, string>;
  };
  tombstone?: {
    reason: string;
    /** Durable successor returned when an explicit rollover request is retried. */
    recoveredSessionId?: string;
    recoveredSessionKey?: string;
  };
};
