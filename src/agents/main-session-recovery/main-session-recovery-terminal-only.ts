/**
 * Whether a main session's restart-recovery fences are all proven terminal. Split out of
 * ./main-session-recovery-state.ts to keep that file within its max-lines budget (10.7 carry).
 */
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { hasRestartRecoveryTerminalRun } from "../../config/sessions/restart-recovery-state.js";

// Retire only proven terminal fences without remaining execution or delivery
// custody; treating unfinished fences as residue loses crash recovery (#118873).
//
// Fork: Gateway-owned callers pass their current lifecycle generation. On a row
// not marked interrupted, a fence whose run died with an earlier Gateway process
// can never record a terminal fact, so it is settled the moment the current
// Gateway sees it (rh-bot 2026-09-03: one such fence held a healthy session at
// "changed while starting work" for 106 retries). An interrupted row's fences are
// its crash recovery and stay authoritative; the gate lives here because 10.5's
// callers (observe, claim_foreground, the startup scan) no longer check
// abortedLastRun first. Standalone callers omit the generation; theirs differs
// from the live Gateway's and must not retire its fences.
export function isMainRestartRecoveryTerminalOnly(entry: SessionEntry, current?: string): boolean {
  const state = entry.mainRestartRecovery;
  if (state?.tombstone || state?.reservation || state?.foregroundClaims) {
    return false;
  }
  if (entry.restartRecoveryDeliveryRunId !== undefined || entry.pendingFinalDelivery) {
    return false;
  }
  const runs = entry.restartRecoveryRuns;
  const settlesDead = current !== undefined && entry.abortedLastRun !== true;
  const owned = settlesDead ? runs?.filter((run) => run.lifecycleGeneration === current) : runs;
  return (
    runs !== undefined &&
    runs.length > 0 &&
    (owned ?? []).every((run) => hasRestartRecoveryTerminalRun(entry, run.runId))
  );
}
