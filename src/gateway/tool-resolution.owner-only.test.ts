// Gateway tool surfaces omit owner-only tools for non-owners; the refusing stubs that
// keep an agent turn's prompt owner-shaped never reach MCP loopback or HTTP invoke.
import { describe, expect, it, vi } from "vitest";
import { createOwnerOnlyToolStub } from "../agents/owner-only-tool-stubs.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function pluginTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} plugin tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
}

// 10.5 builds the surface through the async tool factory, as its own
// tool-resolution tests do; the stub stands in for the plugin layer's output.
// mock-isolation: Real tool construction opens the shared-state store; this test checks only the surface filter.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async () => [
    createOwnerOnlyToolStub(pluginTool("owner_probe")),
    pluginTool("probe"),
  ],
}));
// mock-isolation: No coding tools are needed to check the owner-only filter.
vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingToolsInternalAsync: async () => [],
}));

const { resolveGatewayScopedTools } = await import("./tool-resolution.js");

describe("resolveGatewayScopedTools owner-only plugin tools", () => {
  it.each(["loopback", "http"] as const)(
    "omits owner-only stubs from the %s surface",
    async (surface) => {
      const { tools } = await resolveGatewayScopedTools({
        cfg: { tools: { allow: ["owner_probe", "probe"] } } as OpenClawConfig,
        sessionKey: "agent:main:main",
        senderIsOwner: false,
        surface,
      });
      const names = tools.map((tool) => tool.name);

      expect(names).toContain("probe");
      expect(names).not.toContain("owner_probe");
    },
  );
});
