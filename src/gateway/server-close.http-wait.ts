/**
 * Bounded wait on an HTTP listener's close promise during gateway shutdown: a rejected close
 * is recorded as a shutdown warning and counts as closed.
 * Split out of ./server-close.ts to keep that module within the max-lines budget.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { settlesWithin } from "../shared/settle-within.js";
import { recordGatewayShutdownWarning as recordShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");

export async function waitForHttpClose(params: {
  closePromise: Promise<void>;
  timeoutMs: number;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  return await settlesWithin(params.closePromise, params.timeoutMs).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    shutdownLog.warn(`${params.label}: ${detail}`);
    recordShutdownWarning(params.warnings, params.label);
    return true;
  });
}
