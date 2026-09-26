/**
 * Owner-only tool stubs: a non-owner turn declares every owner-only tool an owner turn
 * would, but each one refuses, and no call path (direct execution, the agent loop's
 * preparer lookup, Tool Search, Code Mode catalog calls, hooks, allowlist inheritance
 * or cron capture) reaches the real tool. Keeps the #102030 guarantee, including its one
 * exception: an exact-run automations grant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { GATEWAY_OWNER_ONLY_CORE_TOOLS } from "../security/dangerous-tools.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapabilityResolver,
} from "./cron-creator-authority-context.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { isOwnerOnlyToolStub, listOwnerOnlyToolStubNames } from "./owner-only-tool-stub-marker.js";
import { createOwnerOnlyToolStub } from "./owner-only-tool-stubs.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { ToolAuthorizationError } from "./tool-input-error.js";
import { replaceWithEffectiveToolAllowlist } from "./tool-policy.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "./tools/cron-tool.js";
import type { CronCreatorToolAllowlistEntry } from "./tools/cron-tool.types.js";

const OWNER_ONLY = [...GATEWAY_OWNER_ONLY_CORE_TOOLS];
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

function buildTurnTools(senderIsOwner: boolean, runId = senderIsOwner ? "owner-run" : "other-run") {
  return createOpenClawCodingTools({
    agentId: "main",
    sessionKey,
    runId,
    senderIsOwner,
    messageProvider: "telegram",
    abortSignal: new AbortController().signal,
    workspaceDir: "/tmp/owner-only-stubs-workspace",
    agentDir: "/tmp/owner-only-stubs-agent",
  });
}

// Only real tools grant anything; a non-owner turn declares owner-only tools as stubs.
function executableNames(tools: readonly AnyAgentTool[]): string[] {
  return tools.filter((tool) => !isOwnerOnlyToolStub(tool)).map((tool) => tool.name);
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

describe("owner-only tool stubs", () => {
  const beforeToolCall = vi.fn();

  beforeEach(() => {
    realSpies.clear();
    beforeToolCall.mockClear();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: beforeToolCall }]),
    );
    // `intent` stands in for a plugin tool registered `ownerOnly`: the plugin resolver
    // already hands a non-owner turn its stub, which then flows through agent policy.
    vi.mocked(createOpenClawTools).mockImplementation((options) => [
      ...OWNER_ONLY.map(createRealTool),
      createRealTool("message"),
      options?.senderIsOwner === true
        ? createRealTool("intent")
        : createOwnerOnlyToolStub(createRealTool("intent")),
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

  it("declares every owner-only tool on a non-owner turn only as a refusing stub (#102030)", async () => {
    const owner = buildTurnTools(true);
    const other = buildTurnTools(false);

    expect(other.map((tool) => tool.name)).toEqual(owner.map((tool) => tool.name));
    expect(listOwnerOnlyToolStubNames(other).toSorted()).toEqual(
      [...OWNER_ONLY, "intent"].toSorted(),
    );
    expect(isOwnerOnlyToolStub(requireTool(other, "message"))).toBe(false);
    for (const name of OWNER_ONLY) {
      const stub = requireTool(other, name);
      const ownerTool = requireTool(owner, name);
      expect(isOwnerOnlyToolStub(stub), name).toBe(true);
      expect(stub.description).toBe(ownerTool.description);
      expect(stub.parameters).toEqual(ownerTool.parameters);
      expect(stub.outputSchema).toEqual(ownerTool.outputSchema);
      expect(stub.resultContentSource).toBeUndefined();
      expect(getInternalToolExecutionPreparer(stub), name).toBeUndefined();
      expect(stub.prepareArguments).toBeUndefined();
      await expect(stub.execute(`call-${name}`, { action: "x" })).rejects.toThrow(
        new ToolAuthorizationError(`${name} is not available on this turn: owner-only.`),
      );
    }
    expectNoRealOwnerOnlyExecution();
    expect(beforeToolCall).not.toHaveBeenCalled();
  });

  it("reaches only the refusal through Tool Search and Code Mode catalog calls", async () => {
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
    // The run's catalog executor prefers an execution preparer over execute, so the
    // cataloged objects themselves must carry neither the real preparer nor hooks.
    const cataloged = (catalogRef.current?.entries ?? []).filter((entry) =>
      OWNER_ONLY.includes(entry.name as (typeof OWNER_ONLY)[number]),
    );
    expect(cataloged.map((entry) => entry.name).toSorted()).toEqual(OWNER_ONLY.toSorted());
    for (const entry of cataloged) {
      expect(isOwnerOnlyToolStub(entry.tool), entry.name).toBe(true);
      expect(getInternalToolExecutionPreparer(entry.tool), entry.name).toBeUndefined();
    }

    await expect(runtime.call("gateway", { action: "config.get" })).rejects.toThrow(
      "gateway is not available on this turn: owner-only.",
    );
    // Code Mode's nodes bridge resolves this exact catalog id.
    await expect(runtime.callExactId("openclaw:core:nodes", { action: "status" })).rejects.toThrow(
      "nodes is not available on this turn: owner-only.",
    );
    expectNoRealOwnerOnlyExecution();
    expect(beforeToolCall).not.toHaveBeenCalled();
  });

  it("keeps hooks and approvals away from stubs in the session tool adapter", async () => {
    const other = buildTurnTools(false);
    // The embedded session adapter runs before_tool_call itself for tools it sees unwrapped.
    const [definition] = toToolDefinitions([requireTool(other, "gateway")], {
      runId: "other-run",
      sessionKey,
    });
    if (!definition) {
      throw new Error("expected the gateway definition");
    }

    const result = await definition.execute(
      "adapter-call",
      { action: "config.get" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.stringify(result.content)).toContain(
      "gateway is not available on this turn: owner-only.",
    );
    expect(getInternalToolExecutionPreparer(definition)).toBeUndefined();
    expectNoRealOwnerOnlyExecution();
    expect(beforeToolCall).not.toHaveBeenCalled();
  });

  it("never passes a stub name on to child sessions or scheduled jobs", () => {
    const other = buildTurnTools(false);
    const inherited: string[] = [];
    replaceWithEffectiveToolAllowlist(inherited, other);
    const cronCaptured: CronCreatorToolAllowlistEntry[] = [];
    captureFinalEffectiveCronCreatorToolAllowlist(cronCaptured, {}, other);

    expect(inherited).toContain("message");
    expect(cronCaptured.map((entry) => (typeof entry === "string" ? entry : entry.name))).toContain(
      "message",
    );
    for (const name of [...OWNER_ONLY, "intent"]) {
      expect(inherited).not.toContain(name);
      expect(
        cronCaptured.map((entry) => (typeof entry === "string" ? entry : entry.name)),
      ).not.toContain(name);
    }
  });

  describe("senderless automations authority", () => {
    it("binds configured MCP cron authority only to the exact admitted run", async () => {
      const resolve = vi.fn().mockResolvedValue({
        tools: ["read", { name: "mcp_todoist_add_task", pluginId: "todoist" }],
        provenance: { version: 1, source: "final-executable-surface" },
      });
      let releaseRun: (() => void) | undefined;
      const holdRun = new Promise<void>((resolveHold) => {
        releaseRun = resolveHold;
      });
      let retainedResolver: (() => Promise<unknown>) | undefined;

      vi.mocked(createOpenClawTools).mockClear();
      const forgedTools = runWithCronCreatorAuthorityCapabilityResolver({
        capability: undefined,
        runId: "forged-run",
        resolve,
        run: () => createOpenClawCodingTools({ runId: "forged-run", senderIsOwner: false }),
      });
      expect(executableNames(forgedTools)).not.toContain("automations");
      expect(
        vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority,
      ).toBeUndefined();

      const capability = createCronCreatorAuthorityCapability("admitted-run")!;
      const activeRun = runWithCronCreatorAuthorityCapability(capability, async () => {
        const wrongRunTools = runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId: "other-run",
          resolve,
          run: () => createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false }),
        });
        expect(executableNames(wrongRunTools)).not.toContain("automations");
        expect(
          vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority,
        ).toBeUndefined();

        const cronCreatorToolAllowlistRef: CronCreatorToolAllowlistEntry[] = [];
        const admittedTools = runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId: "admitted-run",
          resolve,
          run: () =>
            createOpenClawCodingTools({
              runId: "admitted-run",
              senderIsOwner: false,
              cronCreatorToolAllowlistRef,
            }),
        });
        const admittedToolNames = executableNames(admittedTools);
        expect(admittedToolNames).toContain("automations");
        expect(admittedToolNames).not.toContain("gateway");
        expect(admittedToolNames).not.toContain("nodes");
        expect(admittedToolNames).not.toContain("openclaw");
        // The granted run may schedule only what it can run itself, never a stub.
        const captured = cronCreatorToolAllowlistRef.map((entry) =>
          typeof entry === "string" ? entry : entry.name,
        );
        expect(captured).toContain("automations");
        expect(captured).not.toContain("gateway");
        expect(captured).not.toContain("nodes");
        expect(captured).not.toContain("intent");
        retainedResolver =
          vi.mocked(createOpenClawTools).mock.lastCall?.[0]?.resolveCronCreatorToolAuthority;
        expect(retainedResolver).toEqual(expect.any(Function));
        await expect(retainedResolver!()).resolves.toMatchObject({
          provenance: { source: "final-executable-surface" },
        });
        await holdRun;
      });

      releaseRun?.();
      await activeRun;
      await expect(retainedResolver!()).rejects.toThrow(
        "Configured MCP cron authority is no longer active for this run",
      );
      expect(
        executableNames(createOpenClawCodingTools({ runId: "admitted-run", senderIsOwner: false })),
      ).not.toContain("automations");
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("drops senderless Automations retention when exact authority aborts or errors", async () => {
      const resolve = async () => ({
        tools: ["read"],
        provenance: { version: 1 as const, source: "final-executable-surface" as const },
      });
      const buildTools = (capability: ReturnType<typeof createCronCreatorAuthorityCapability>) =>
        runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId: "lifecycle-run",
          resolve,
          run: () => createOpenClawCodingTools({ runId: "lifecycle-run", senderIsOwner: false }),
        });

      const abortController = new AbortController();
      const abortedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
      await runWithCronCreatorAuthorityCapability(
        abortedCapability,
        async () => {
          expect(executableNames(buildTools(abortedCapability))).toContain("automations");
          abortController.abort(new Error("run cancelled"));
          expect(executableNames(buildTools(abortedCapability))).not.toContain("automations");
        },
        abortController.signal,
      );
      expect(abortedCapability.active).toBe(false);

      const failedCapability = createCronCreatorAuthorityCapability("lifecycle-run")!;
      await expect(
        runWithCronCreatorAuthorityCapability(failedCapability, async () => {
          expect(executableNames(buildTools(failedCapability))).toContain("automations");
          throw new Error("run failed");
        }),
      ).rejects.toThrow("run failed");
      expect(failedCapability.active).toBe(false);
      expect(
        executableNames(
          createOpenClawCodingTools({ runId: "lifecycle-run", senderIsOwner: false }),
        ),
      ).not.toContain("automations");
    });
  });
});
