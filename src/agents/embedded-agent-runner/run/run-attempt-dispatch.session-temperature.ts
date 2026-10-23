/** Session-level /temperature override for embedded run attempt dispatch.
 *
 * Split out of ./run-attempt-dispatch.ts to keep that module within the
 * max-lines budget. The export is re-exported from ./run-attempt-dispatch.ts so
 * existing import paths are unchanged.
 */
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";

/**
 * Best-effort read of the session-level sampling temperature set with /temperature.
 * Returns undefined when the session has no override, so configured model params win.
 *
 * Carried onto 9.3, which deleted attempt-dispatch-preparation.ts and inlined its
 * work here. The feature is fork-only, so nothing upstream would restore it.
 */
export function resolveSessionTemperatureOverride(params: {
  agentId: string;
  sessionKey: string | undefined;
  storePath?: string;
}): number | undefined {
  const { agentId, sessionKey, storePath } = params;
  if (!sessionKey?.trim()) {
    return undefined;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      agentId,
      storePath: storePath ?? resolveSessionStorePathCore(undefined, { agentId }),
      sessionKey,
    });
    return typeof entry?.temperature === "number" ? entry.temperature : undefined;
  } catch {
    return undefined;
  }
}

/** The session override as extra stream params; empty when the session has none. */
export function resolveSessionTemperatureParams(
  params: Parameters<typeof resolveSessionTemperatureOverride>[0],
): { temperature?: number } {
  const temperature = resolveSessionTemperatureOverride(params);
  return temperature !== undefined ? { temperature } : {};
}
