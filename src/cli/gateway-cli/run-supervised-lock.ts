// Supervised gateway lock recovery outcomes: the exit code a supervisor sees
// when a prior gateway keeps the lock, and the once-per-cycle zombie signal.
import { recordGatewayRestartTrace } from "../../gateway/restart-trace.js";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";

/**
 * EX_CONFIG (78) from sysexits.h — used for configuration errors so systemd
 * (via RestartPreventExitStatus=78) stops restarting instead of entering a
 * restart storm that can render low-resource hosts unresponsive.
 */
export const EXIT_CONFIG_ERROR = 78;

export class SupervisedGatewayLockError extends GatewayLockError {
  constructor(
    message: string,
    cause: unknown,
    readonly exitCode: 1 | typeof EXIT_CONFIG_ERROR,
  ) {
    super(message, cause);
  }
}

export function resolveGatewayLockErrorExitCode(err: unknown): number {
  return err instanceof SupervisedGatewayLockError ? err.exitCode : 1;
}

/**
 * Probe came back unhealthy while the lock is held: either the previous
 * gateway is mid-shutdown (503 from /healthz?strict=1) or it is a zombie that
 * lost the close path but kept the HTTP listener. Log once per recovery cycle,
 * not every retry tick, so a normal 30s drain cannot inflate telemetry.
 */
export function createGatewayZombieDetectionLog(
  supervisor: RespawnSupervisor,
  target: { port: number; log: Pick<ReturnType<typeof createSubsystemLogger>, "warn"> },
): (elapsedMs: number, shouldRetry: boolean) => void {
  // Dedup the zombie_detected signal across the recovery cycle. Cleared when
  // the cycle resolves (either the prior gateway becomes healthy and we defer,
  // or we time out and throw); a fresh recovery later starts a new cycle.
  const zombieDetection = { loggedThisCycle: false };
  return (elapsedMs, shouldRetry) => {
    if (!zombieDetection.loggedThisCycle) {
      recordGatewayRestartTrace("gateway.preflight.zombie_detected", elapsedMs, [
        ["supervisor", supervisor],
        ["port", target.port],
      ]);
      target.log.warn(
        `gateway.preflight.zombie_detected supervisor=${supervisor} port=${target.port}; lock held but /healthz reported unhealthy (likely zombie or draining)`,
      );
      if (shouldRetry) {
        zombieDetection.loggedThisCycle = true;
      }
    }
  };
}
