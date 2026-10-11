/**
 * Refusing stand-ins for owner-only tools on non-owner turns.
 *
 * A non-owner turn (for example a subagent completion dispatched with a synthetic
 * system client) keeps the owner turn's tool declarations so the model-facing tool
 * list, and the prompt text derived from it, stay byte-identical across senders and
 * provider prompt caches survive the sender switch. Each owner-only tool the sender
 * may not run is replaced by a stub that carries its declaration and nothing else.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isOwnerOnlyToolStub, markOwnerOnlyToolStub } from "./owner-only-tool-stub-marker.js";
import { attachInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { ToolAuthorizationError } from "./tool-input-error.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import { registerTrustedToolNoStartError } from "./tool-result-error.js";

const log = createSubsystemLogger("agents/owner-only-tools");

function ownerOnlyToolRefusalMessage(toolName: string): string {
  return `${toolName} is not available on this turn: owner-only.`;
}

/**
 * Per-turn note for the prompt's volatile suffix. The tool list above the cache
 * boundary stays the owner turn's, so this is where the model learns which of those
 * tools refuse on this turn.
 */
export function buildOwnerOnlyToolsUnavailablePrompt(
  toolNames: readonly string[] | undefined,
): string | undefined {
  if (!toolNames?.length) {
    return undefined;
  }
  const list = toolNames.map((name) => `\`${name}\``).join(", ");
  return `Owner-only tools unavailable on this turn; calls to them are refused: ${list}.`;
}

/**
 * Build the refusing stand-in for one owner-only tool.
 *
 * The stub is a fresh object that copies only the tool's data fields (name, label,
 * description, parameters, output schema and similar declaration metadata). It never
 * copies function fields (`execute`, `prepareArguments`, before-tool-call param hooks,
 * timeout budgets) or identity-bound metadata (the real tool's execution preparer,
 * before-tool-call source edges, availability bindings), so no call path can reach the
 * real tool through it. It does not carry `resultContentSource`: a refusal has no
 * external content.
 *
 * A refusal is a pre-execution block, never a started call: the stub's own preparer
 * returns the host's standard blocked result immediately (so the agent loop reports
 * `executionStarted: false` and skips after-tool-call handlers, as for a
 * before_tool_call veto), and callers that bypass preparers get a trusted no-start error.
 */
export function createOwnerOnlyToolStub(
  tool: AnyAgentTool,
  context: { runId?: string; sessionKey?: string } = {},
): AnyAgentTool {
  const declaration: Record<string, unknown> = {};
  const fields: [string, unknown][] = Object.entries(tool);
  for (const [key, value] of fields) {
    if (typeof value === "function" || key === "resultContentSource") {
      continue;
    }
    declaration[key] = value;
  }
  const toolName = tool.name;
  const reason = ownerOnlyToolRefusalMessage(toolName);
  const logRefusal = () =>
    log.info(`refused owner-only tool ${toolName} on a non-owner turn`, {
      tool: toolName,
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
    });
  const stub: AnyAgentTool = {
    ...declaration,
    name: toolName,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute: async () => {
      logRefusal();
      throw registerTrustedToolNoStartError(new ToolAuthorizationError(reason));
    },
  };
  attachInternalToolExecutionPreparer(stub, async ({ toolCallId }) => {
    logRefusal();
    return {
      kind: "immediate",
      outcome: {
        kind: "result",
        result: buildBlockedToolResult({
          reason,
          deniedReason: "owner-only",
          toolCallId,
          runId: context.runId,
        }),
        isError: true,
      },
      dispose() {},
    };
  });
  return markOwnerOnlyToolStub(stub);
}

/**
 * A client tool with an owner-only tool's name replaces its stub, as it did when
 * non-owner turns omitted owner-only tools; on owner turns the same name conflicts.
 */
export function dropOwnerOnlyToolStubsNamed<T extends { name: string }>(
  tools: T[],
  names: readonly string[],
): T[] {
  const claimed = new Set(names.map((name) => normalizeToolPolicyName(name)));
  return claimed.size === 0
    ? tools
    : tools.filter(
        (tool) => !isOwnerOnlyToolStub(tool) || !claimed.has(normalizeToolPolicyName(tool.name)),
      );
}

/**
 * Rebuild the owner turn's tool order for a non-owner turn: tools the sender may run
 * stay as they are, a stub already in the shape (a plugin's `ownerOnly` tool) stays in
 * place, and every tool that only the owner-only policy removed comes back as a
 * refusing stub in its owner-turn position. Policy filters are per-name predicates, so
 * the authorized tools are exactly the owner shape minus that policy and the stubs; if
 * they are not, keep the authorized list instead of guessing an order.
 */
export function restoreOwnerOnlyToolShape(params: {
  authorizedTools: readonly AnyAgentTool[];
  ownerShapedTools: readonly AnyAgentTool[];
  isOwnerOnly: (toolName: string) => boolean;
  context?: { runId?: string; sessionKey?: string };
}): AnyAgentTool[] {
  const authorizedByName = new Map<string, AnyAgentTool>();
  const unshaped = (reason: string, names: string[]) => {
    log.warn(`owner-only tool shape unavailable (${reason}); sending no stubs`, { names });
    return [...params.authorizedTools];
  };
  for (const tool of params.authorizedTools) {
    if (authorizedByName.has(tool.name)) {
      return unshaped("duplicate tool name", [tool.name]);
    }
    authorizedByName.set(tool.name, tool);
  }
  const shaped: AnyAgentTool[] = [];
  for (const tool of params.ownerShapedTools) {
    const authorized = authorizedByName.get(tool.name);
    if (authorized) {
      authorizedByName.delete(tool.name);
      shaped.push(authorized);
    } else if (isOwnerOnlyToolStub(tool)) {
      shaped.push(tool);
    } else if (params.isOwnerOnly(tool.name)) {
      shaped.push(createOwnerOnlyToolStub(tool, params.context));
    }
  }
  if (authorizedByName.size > 0) {
    return unshaped("unplaced authorized tools", [...authorizedByName.keys()]);
  }
  return shaped;
}
