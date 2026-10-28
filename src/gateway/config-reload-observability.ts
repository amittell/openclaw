import type { ConfigSourceObservation } from "../config/source.js";
import type { GatewayReloadMode } from "../config/types.gateway.js";
import { trackReloadObservation } from "./config-reload-observed.js";
import type { GatewayConfigReloaderOptions } from "./config-reload.types.js";

/**
 * Tracks one reloader transaction's source read against the reloader's live
 * observation. `acceptedFromRevision` records the revision whose transaction
 * accepted a same-source watcher echo, so that read stays publishable.
 */
export function trackSourceReloadObservation(
  source: { readonly observation: ConfigSourceObservation },
  acceptedFromRevision: WeakMap<ConfigSourceObservation, number>,
) {
  return trackReloadObservation(() => ({
    epoch: source.observation.revision,
    acceptedFromEpoch: acceptedFromRevision.get(source.observation),
  }));
}

/** Explains why a hot-capable (hybrid) reload ended in a scheduled gateway restart. */
export function warnHybridRestart(
  log: GatewayConfigReloaderOptions["log"],
  mode: GatewayReloadMode,
  restartReasons: readonly string[],
): void {
  if (mode === "hybrid") {
    const reasons = restartReasons.join(", ");
    log.warn(`config reload requires gateway restart; hybrid mode scheduling restart (${reasons})`);
  }
}
