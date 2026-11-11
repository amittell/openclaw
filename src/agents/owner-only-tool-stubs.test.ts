/**
 * Owner-only tools on a non-owner turn: the turn declares every owner-only tool an owner
 * turn would, with the owner's definition, and no call path (direct execution, the agent
 * loop's preparer lookup, the session adapter, Tool Search, Code Mode catalog calls,
 * availability-bound tools, allowlist inheritance or cron capture) reaches the real tool.
 * Since v2026.11.1 core owner-only tools are gated in place (`resolveTurnToolSurface`); a
 * plugin tool registered `ownerOnly` is still the fork's refusing stub. Keeps #102030.
 */
import { expectDefined } from "@openclaw/normalization-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { runAgentLoop, type AgentEvent } from "../plugin-sdk/agent-core.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { expectOwnerGated } from "./agent-tools.turn-authority.test-support.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { isOwnerOnlyToolStub, listOwnerOnlyToolStubNames } from "./owner-only-tool-stub-marker.js";
import { createOwnerOnlyToolStub } from "./owner-only-tool-stubs.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import type { CronCreatorToolAllowlistEntry } from "./tools/cron-tool.types.js";

const OWNER_ONLY = [...GATEWAY_OWNER_ONLY_CORE_TOOLS];
// Since #154239 (v2026.10.1) `sessions` gates its own actions on a non-owner turn
// (assign_owner only) instead of being denied, so it stays the real tool there.
const GATED_OWNER_ONLY = OWNER_ONLY.filter((name) => name !== "sessions");
// Since v2026.10.7 (#176892) `intent` is itself a core owner-only tool, so a synthetic name stands
// in for a plugin tool registered `ownerOnly`; the fork keeps that path for other plugin tools.
const PLUGIN_OWNER_ONLY = "plugin_owner_only_probe";
const sessionKey = "agent:main:telegram:direct:owner";

function createRealToolSpies(name: string) {
  return {
    execute: vi.fn<AnyAgentTool["execute"]>(async () => jsonResult({ ran: name })),
    prepareArguments: vi.fn((args: unknown) => args),
    preparer: vi.fn((_params: unknown) => undefined),
  };
}

type RealToolSpies = ReturnType<typeof createRealToolSpies>;

const realSpies = new Map<string, RealToolSpies>();

function createRealTool(name: string): AnyAgentTool {
  const spies = createRealToolSpies(name);
  realSpies.set(name, spies);
  const tool: AnyAgentTool = {
    name,
    label: name,
    description: `${name} real tool`,
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    },
    outputSchema: { type: "object", properties: { ran: { type: "string" } } },
    resultContentSource: "network",
    prepareArguments: spies.prepareArguments,
    execute: spies.execute,
  };
  // The agent loop prefers this preparer over execute; a stub must not inherit it.
  attachInternalToolExecutionPreparer(tool, async (params) => {
    spies.preparer(params);
    return {
      kind: "ready",
      args: params.args,
      execute: async () => await spies.execute(params.toolCallId, params.args),
      dispose: () => {},
    };
  });
  return tool;
}

function turnOptions(senderIsOwner: boolean, runId = senderIsOwner ? "owner-run" : "other-run") {
  return {
    agentId: "main",
    sessionKey,
    runId,
    senderIsOwner,
    messageProvider: "telegram",
    abortSignal: new AbortController().signal,
    workspaceDir: "/tmp/owner-only-stubs-workspace",
    agentDir: "/tmp/owner-only-stubs-agent",
  };
}

function buildTurnTools(senderIsOwner: boolean, runId?: string) {
  return createOpenClawCodingTools(turnOptions(senderIsOwner, runId));
}

function requireTool(tools: readonly AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`missing tool ${name}`);
  }
  return tool;
}

function expectNoRealOwnerOnlyExecution() {
  for (const name of OWNER_ONLY) {
    const spies = realSpies.get(name);
    expect(spies?.execute, name).not.toHaveBeenCalled();
    expect(spies?.prepareArguments, name).not.toHaveBeenCalled();
    expect(spies?.preparer, name).not.toHaveBeenCalled();
  }
}

type CallableTool = { execute: (...args: never[]) => Promise<unknown> };

// The agent loop, the session adapter and the Tool Search executor prefer an execution
// preparer over `execute`, so whatever the preparer leads to must be the gate as well.
async function callAsTheLoopWould(tool: CallableTool, name: string): Promise<unknown> {
  const preparer = getInternalToolExecutionPreparer(tool);
  if (!preparer) {
    const execute = tool.execute as (id: string, args: object) => Promise<unknown>;
    return await execute(`call-${name}`, { action: "x" });
  }
  const prepared = await preparer({ toolCallId: `prepare-${name}`, args: { action: "x" } });
  try {
    if (prepared.kind === "ready") {
      return await prepared.execute();
    }
    return prepared.outcome.kind === "result" ? prepared.outcome.result : prepared.outcome.error;
  } finally {
    prepared.dispose();
  }
}

function ownerGateText(name: string): string {
  return `${name} needs the owner's authority`;
}

const loopModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function loopAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: loopModel.api,
    provider: loopModel.provider,
    model: loopModel.id,
    usage: createZeroUsageFixture(),
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

describe("owner-only tool stubs", () => {
  const beforeToolCall = vi.fn();

  beforeEach(() => {
    realSpies.clear();
    beforeToolCall.mockClear();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    // PLUGIN_OWNER_ONLY stands in for a plugin tool registered `ownerOnly`: the plugin resolver
    // already hands a non-owner turn its stub, which then flows through agent policy.
    vi.mocked(createOpenClawTools).mockImplementation((options) => [
      ...OWNER_ONLY.map(createRealTool),
      createRealTool("message"),
      options?.senderIsOwner === true
        ? createRealTool(PLUGIN_OWNER_ONLY)
        : createOwnerOnlyToolStub(createRealTool(PLUGIN_OWNER_ONLY)),
    ]);
  });

  afterEach(() => {
    resetGlobalHookRunner();
    vi.mocked(createOpenClawTools).mockReset();
  });

  it("keeps owner turns on the real tools", async () => {
    const tools = buildTurnTools(true);

    expect(tools.filter(isOwnerOnlyToolStub)).toEqual([]);
    await requireTool(tools, "gateway").execute("owner-call", { action: "config.get" });
    expect(realSpies.get("gateway")?.execute).toHaveBeenCalledTimes(1);
    expect(beforeToolCall).toHaveBeenCalledTimes(1);
  });

  it("declares every owner-only tool on a non-owner turn with the owner's definition, and gates it (#102030)", async () => {
    const owner = buildTurnTools(true);
    const other = buildTurnTools(false);

    expect(other.map((tool) => tool.name)).toEqual(owner.map((tool) => tool.name));
    // Core owner-only tools are gated in place; only the plugin's own owner-only tool is a stub.
    expect(listOwnerOnlyToolStubNames(other)).toEqual([PLUGIN_OWNER_ONLY]);
    for (const name of GATED_OWNER_ONLY) {
      const gated = requireTool(other, name);
      const ownerTool = requireTool(owner, name);
      expect(gated.description, name).toBe(ownerTool.description);
      expect(gated.parameters, name).toEqual(ownerTool.parameters);
      expect(JSON.stringify(await callAsTheLoopWould(gated, name)), name).toContain(
        ownerGateText(name),
      );
    }
    await expectOwnerGated(other, ...GATED_OWNER_ONLY);
    expectNoRealOwnerOnlyExecution();
  });

  it("runs only the gate through Tool Search and Code Mode catalog calls", async () => {
    const other = buildTurnTools(false);
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: other,
      hookContext: { runId: "other-run", sessionId: "session-1", sessionKey },
    });
    const runtime = new ToolSearchRuntime(
      { catalogRef, runId: "other-run", sessionId: "session-1", sessionKey },
      resolveToolSearchConfig(),
    );
    const cataloged = (catalogRef.current?.entries ?? []).filter((entry) =>
      GATED_OWNER_ONLY.includes(entry.name as (typeof GATED_OWNER_ONLY)[number]),
    );
    expect(cataloged.map((entry) => entry.name).toSorted()).toEqual(GATED_OWNER_ONLY.toSorted());
    for (const entry of cataloged) {
      expect(
        JSON.stringify(await callAsTheLoopWould(entry.tool, entry.name)),
        entry.name,
      ).toContain(ownerGateText(entry.name));
    }

    expect(JSON.stringify(await runtime.call("gateway", { action: "config.get" }))).toContain(
      ownerGateText("gateway"),
    );
    // Code Mode's nodes bridge resolves this exact catalog id.
    expect(
      JSON.stringify(await runtime.callExactId("openclaw:core:nodes", { action: "status" })),
    ).toContain(ownerGateText("nodes"));
    expectNoRealOwnerOnlyExecution();
  });

  it("returns the gate, never the real tool, through the session adapter and the agent loop", async () => {
    const runId = "other-run";
    const gated = requireTool(buildTurnTools(false, runId), "nodes");
    const args = { action: "invoke", node: "mac", invokeCommand: "system.run" };
    // The embedded session adapter runs before_tool_call itself for tools it sees unwrapped.
    const [definition] = toToolDefinitions([gated], { runId, sessionKey });
    expect(
      JSON.stringify(
        await callAsTheLoopWould(expectDefined(definition, "nodes definition"), "nodes"),
      ),
    ).toContain(ownerGateText("nodes"));

    const events: AgentEvent[] = [];
    let turn = 0;
    const streamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message =
          turn === 1
            ? loopAssistant([{ type: "toolCall", id: "loop-call", name: "nodes", arguments: args }])
            : loopAssistant([{ type: "text", text: "done" }]);
        stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    };
    await runAgentLoop(
      [{ role: "user", content: "run it", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [gated] },
      { model: loopModel, convertToLlm: (messages) => messages as Message[] },
      (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );

    const end = expectDefined(
      events.find(
        (event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
          event.type === "tool_execution_end" && event.toolCallId === "loop-call",
      ),
      "tool_execution_end",
    );
    expect(end.result).toMatchObject({ details: { gated: true } });
    expect(JSON.stringify(end.result)).toContain(ownerGateText("nodes"));
    expectNoRealOwnerOnlyExecution();
  });

  it("never counts a gated tool or a stub as callable for availability-bound tools", () => {
    const callable: string[] = [];
    const probe = bindAgentToolAvailability(createRealTool("probe"), {
      prepare: (_tool, callableTools) => {
        callable.splice(0, callable.length, ...callableTools.keys());
      },
      prepareBeforeNormalization: true,
    });
    const assemble = expectDefined(
      vi.mocked(createOpenClawTools).getMockImplementation(),
      "createOpenClawTools implementation",
    );
    vi.mocked(createOpenClawTools).mockImplementation((options) => [...assemble(options), probe]);

    buildTurnTools(false);

    expect(callable).toContain("message");
    for (const name of [...GATED_OWNER_ONLY, PLUGIN_OWNER_ONLY]) {
      expect(callable).not.toContain(name);
    }
  });

  it("never passes a gated or stubbed name on to child sessions or scheduled jobs", () => {
    const inheritedToolAllowlistRef: string[] = [];
    const cronCreatorToolAllowlistRef: CronCreatorToolAllowlistEntry[] = [];
    createOpenClawCodingTools({
      ...turnOptions(false),
      // A restrictive inherited allowlist is what makes the turn export one to children.
      runtimeToolAllowlist: [...OWNER_ONLY, "message", PLUGIN_OWNER_ONLY],
      inheritRuntimeToolAllowlist: true,
      inheritedToolAllowlistRef,
      cronCreatorToolAllowlistRef,
    });
    const cronCaptured = cronCreatorToolAllowlistRef.map((entry) =>
      typeof entry === "string" ? entry : entry.name,
    );

    expect(inheritedToolAllowlistRef).toContain("message");
    expect(cronCaptured).toContain("message");
    for (const name of [...GATED_OWNER_ONLY, PLUGIN_OWNER_ONLY]) {
      expect(inheritedToolAllowlistRef).not.toContain(name);
      expect(cronCaptured).not.toContain(name);
    }
  });
});
