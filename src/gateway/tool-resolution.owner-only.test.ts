// Gateway tool surfaces omit owner-only tools for non-owners; the refusing stubs that
// keep an agent turn's prompt owner-shaped never reach MCP loopback or HTTP invoke.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginTools from "../agents/openclaw-plugin-tools.js";
import { createOwnerOnlyToolStub } from "../agents/owner-only-tool-stubs.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

function pluginTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} plugin tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("resolveGatewayScopedTools owner-only plugin tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["loopback", "http"] as const)(
    "omits owner-only stubs from the %s surface",
    (surface) => {
      vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockReturnValue([
        createOwnerOnlyToolStub(pluginTool("owner_probe")),
        pluginTool("probe"),
      ]);

      const names = resolveGatewayScopedTools({
        cfg: { tools: { allow: ["owner_probe", "probe"] } } as OpenClawConfig,
        sessionKey: "agent:main:main",
        senderIsOwner: false,
        surface,
      }).tools.map((tool) => tool.name);

      expect(names).toContain("probe");
      expect(names).not.toContain("owner_probe");
    },
  );
});
