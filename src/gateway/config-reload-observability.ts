import type { ConfigSourceObservation } from "../config/source.js";
import type { GatewayReloadMode } from "../config/types.gateway.js";
import { trackReloadObservation } from "./config-reload-observed.js";
import type { GatewayConfigReloaderOptions } from "./config-reload.types.js";

/**
 * Tracks one reloader transaction's source read against the reloader's live
 * observation. The reload queue serializes passes, so a watcher event (including
 * a write's own echo) that lands mid-transaction is read and published by its
 * own next pass; this read publishes only while its revision is still current.
 */
export function trackSourceReloadObservation(source: {
  readonly observation: ConfigSourceObservation;
}) {
  return trackReloadObservation(() => source.observation.revision);
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
