import { recordSessionPendingInputCompletedTurn } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { createAgentRunDiagnostics } from "./agent-run-diagnostics.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/**
 * Fire-and-forget answered-turn marker. Callers reach it only from the run's success exit
 * (`await execution` returned without throwing and without an abort), so a run that
 * died, threw or was cancelled leaves no marker and stays re-drivable.
 */
export function recordAgentRunCompletedTurnMarker(
  params: StartAgentRunExecutionParams,
  diagnostics: Pick<ReturnType<typeof createAgentRunDiagnostics>, "warning">,
): void {
  const requestHash = params.prepared.userTurn.recorder?.getPendingInputRequestHash?.();
  const markerSessionKey = params.resolvedSessionKey;
  const expectedSessionId = params.resolvedSessionId;
  if (!requestHash || !markerSessionKey || !expectedSessionId) {
    return;
  }
  void recordSessionPendingInputCompletedTurn(
    {
      agentId: params.activeSessionAgentId,
      sessionKey: markerSessionKey,
      ...(params.storePath ? { storePath: params.storePath } : {}),
    },
    { expectedSessionId, requestHash },
  ).catch(diagnostics.warning("failed to record answered agent turn marker"));
}
