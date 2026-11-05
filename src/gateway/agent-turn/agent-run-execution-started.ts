// Split out of agent-run-execution-phase.ts, which sits at the line cap.
import { emitSessionsChanged } from "../server-methods/session-change-event.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Marks the admitted run started once, then tells the caller and the session watchers. */
export function createAgentRunExecutionStartedHandler(
  params: StartAgentRunExecutionParams,
): () => void {
  return () => {
    if (!params.prepared.activeRunAbort.markExecutionStarted()) {
      return;
    }
    params.io.emitExecutionStarted?.();
    if (params.resolvedSessionKey) {
      emitSessionsChanged(
        params.context,
        {
          sessionKey: params.resolvedSessionKey,
          agentId: params.agentId,
          reason: "agent.run.started",
        },
        { accessChanged: false },
      );
    }
  };
}
