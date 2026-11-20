/** Tool denylist matching for plugin-contributed agent tools, by tool name and by owning plugin. */
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";

export function normalizeDenylist(list?: string[]) {
  return compileGlobPatterns({
    raw: list,
    normalize: normalizeToolPolicyName,
  });
}

export function denylistBlocksName(
  name: string,
  denylist: ReturnType<typeof normalizeDenylist>,
): boolean {
  const normalized = normalizeToolPolicyName(name);
  return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}

export function denylistBlocksPlugin(params: {
  pluginId: string;
  denylist: ReturnType<typeof normalizeDenylist>;
}): boolean {
  return (
    denylistBlocksName(params.pluginId, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  );
}
