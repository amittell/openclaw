/** Session-level /temperature override for embedded run attempt dispatch.
 *
 * Split out of ./run-attempt-dispatch.ts to keep that module within the
 * max-lines budget.
 */
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";

/**
 * Best-effort read of the session-level sampling temperature set with /temperature.
 * Returns undefined when the session has no override, so configured model params win.
 *
 * Carried onto 9.3, which deleted attempt-dispatch-preparation.ts and inlined its
 * work here. The feature is fork-only, so nothing upstream would restore it. The read
 * runs in the session worker (11.5 carry): dispatch runs on the Gateway main thread.
 * It must stay read-only: a detached run may have no agent database yet, and a
 * writable open would create one.
 */
export async function resolveSessionTemperatureOverride(params: {
  agentId: string;
  sessionKey: string | undefined;
  storePath?: string;
}): Promise<number | undefined> {
  const { agentId, sessionKey, storePath } = params;
  if (!sessionKey?.trim()) {
    return undefined;
  }
  try {
    const entry = await readSessionEntryReadOnlyInWorker({ agentId, sessionKey, storePath });
    return typeof entry?.temperature === "number" ? entry.temperature : undefined;
  } catch {
    return undefined;
  }
}

/** The session override as extra stream params; empty when the session has none. */
export async function resolveSessionTemperatureParams(
  runInput: Pick<
    PreparedEmbeddedRunInput,
    "workspaceResolution" | "resolvedSessionKey" | "runParams"
  >,
): Promise<{ temperature?: number }> {
  const temperature = await resolveSessionTemperatureOverride({
    agentId: runInput.workspaceResolution.agentId,
    sessionKey: runInput.resolvedSessionKey,
    storePath: runInput.runParams.config?.session?.store,
  });
  return temperature !== undefined ? { temperature } : {};
}
