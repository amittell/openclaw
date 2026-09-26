/**
 * Assembles a turn's tool surface from its policy-filtered tools: host ring-zero
 * tools, the delegation capability, then the swarm collector contract. A non-owner
 * turn also gets a model-facing list that keeps the owner turn's declarations, with a
 * refusing stub for each owner-only tool (owner-only-tool-stubs.ts). Grants such as
 * sessions_spawn inheritance and cron capture must read `authorizedTools` only.
 */
import { mergeAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { applyDelegationCapability, type DelegationCapability } from "./delegation-capability.js";
import { applySwarmCollectorToolContract } from "./openclaw-tools.swarm.js";
import { restoreOwnerOnlyToolShape } from "./owner-only-tool-stubs.js";
import type { createEmbeddedMessageInvocationPolicy } from "./scheduled-message-invocation.js";

export function assembleTurnToolSurface(params: {
  policy: Pick<ReturnType<typeof createEmbeddedMessageInvocationPolicy>, "filterTurn">;
  ringZeroTools: readonly AnyAgentTool[];
  delegationCapability?: DelegationCapability;
  swarmCollector?: boolean;
  structuredOutputTool?: AnyAgentTool;
  stubContext: { runId?: string; sessionKey?: string };
}): { authorizedTools: AnyAgentTool[]; modelFacingTools: AnyAgentTool[] } {
  // Host-bound ring-zero tools carry their own authority checks. Agent policy
  // must not deadlock setup, but the tools still receive schema/hook wrappers.
  const assemble = (filtered: AnyAgentTool[]) =>
    applySwarmCollectorToolContract(
      applyDelegationCapability(
        mergeAgentRingZeroTools(params.ringZeroTools, filtered),
        params.delegationCapability,
      ),
      { swarmCollector: params.swarmCollector, structuredOutputTool: params.structuredOutputTool },
    );
  const { authorized, ownerShape } = params.policy.filterTurn();
  const authorizedTools = assemble(authorized);
  return {
    authorizedTools,
    modelFacingTools: ownerShape
      ? restoreOwnerOnlyToolShape({
          authorizedTools,
          ownerShapedTools: assemble(ownerShape.tools),
          isOwnerOnly: ownerShape.isOwnerOnly,
          context: params.stubContext,
        })
      : authorizedTools,
  };
}
