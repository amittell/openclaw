import { retainLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

/**
 * Retains Doctor's resolved legacy default-agent owner on each config it carries toward the
 * write: the working configs once the owner resolves, and (fork, from the 2026.8.1-beta.2
 * release repair that main never took) the config Doctor finally writes, so the state repairs
 * after the write still resolve preimage ownership. An unresolved owner changes nothing.
 */
export function retainResolvedLegacyDefaultAgentId(
  agentId: string | undefined,
  ...configs: OpenClawConfig[]
): void {
  if (!agentId) {
    return;
  }
  for (const config of configs) {
    retainLegacyDefaultAgentId(config, agentId);
  }
}
