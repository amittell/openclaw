/**
 * Owner-only tool stubs: a non-owner turn declares every owner-only tool an owner turn
 * would, but each one refuses, and no call path (direct execution, the agent loop's
 * preparer lookup, Tool Search, Code Mode catalog calls, hooks, allowlist inheritance
 * or cron capture) reaches the real tool. Keeps the #102030 guarantee, including its one
 * exception: an exact-run automations grant.
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
import {
  bindAgentToolAvailability,
  finalizeAgentToolAvailability,
} from "./agent-tool-availability.js";
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
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";
import { ToolAuthorizationError } from "./tool-input-error.js";
import { replaceWithEffectiveToolAllowlist } from "./tool-policy.js";
import { consumeTrustedToolNoStartError, isToolResultError } from "./tool-result-error.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";
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

// A refusal is a pre-execution block: the preparer the agent loop prefers answers at once.
async function expectPreExecutionRefusal(tool: object, name: string) {
  const preparer = expectDefined(getInternalToolExecutionPreparer(tool), `${name} preparer`);
  const prepared = await preparer({ toolCallId: `prepare-${name}`, args: { action: "x" } });
  expect(prepared, name).toMatchObject({
    kind: "immediate",
    outcome: {
      kind: "result",
      isError: true,
      result: { details: { status: "blocked", deniedReason: "owner-only" } },
    },
  });
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
      expect(stub.prepareArguments).toBeUndefined();
      await expectPreExecutionRefusal(stub, name);
      // Callers that bypass preparers get host-owned proof that nothing started.
      const error = await stub.execute(`call-${name}`, { action: "x" }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toEqual(
        new ToolAuthorizationError(`${name} is not available on this turn: owner-only.`),
      );
      expect(consumeTrustedToolNoStartError(error), name).toBe(true);
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
      await expectPreExecutionRefusal(entry.tool, entry.name);
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

  it("records a refusal as a blocked call that never started, through the adapter and loop", async () => {
    const runId = "other-run";
    const stub = requireTool(buildTurnTools(false, runId), "nodes");
    const args = { action: "invoke", node: "mac", invokeCommand: "system.run" };
    // The embedded session adapter runs before_tool_call itself for tools it sees unwrapped.
    const [definition] = toToolDefinitions([stub], { runId, sessionKey });
    await expectPreExecutionRefusal(expectDefined(definition, "nodes definition"), "nodes");

    const events: AgentEvent[] = [];
    const afterToolCall = vi.fn();
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
      { systemPrompt: "", messages: [], tools: [stub] },
      {
        model: loopModel,
        convertToLlm: (messages) => messages as Message[],
        // Mirrors the session: tool_result handlers run only for started calls.
        afterToolCall,
        afterToolOutcome: async ({ executionStarted, result, isError }) =>
          executionStarted ? undefined : { isError: isError || isToolResultError(result) },
      },
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
    expect(end).toMatchObject({
      executionStarted: false,
      isError: true,
      result: { details: { status: "blocked", deniedReason: "owner-only" } },
    });
    expect(afterToolCall).not.toHaveBeenCalled();
    // The host observer turns this into no side-effect evidence, so replay stays valid.
    expect(
      createToolTerminalObserver(runId)({
        toolCallId: "loop-call",
        toolName: "nodes",
        arguments: args,
        executionStarted: end.executionStarted,
        outcome: "failure",
        result: end.result,
        failure: { error: "nodes is not available on this turn: owner-only." },
      }),
    ).toMatchObject({
      executionStarted: false,
      sideEffectEvidence: false,
      lastToolError: { executionStarted: false, mutatingAction: false },
    });
    expectNoRealOwnerOnlyExecution();
    expect(beforeToolCall).not.toHaveBeenCalled();
  });

  it("never counts a stub as callable for availability-bound tools", () => {
    const callable: string[] = [];
    const probe = bindAgentToolAvailability(
      { name: "probe", description: "probe", parameters: { type: "object", properties: {} } },
      { prepare: (_tool, callableTools) => callable.push(...callableTools.keys()) },
    );

    finalizeAgentToolAvailability([probe, ...buildTurnTools(false)]);

    expect(callable).toContain("message");
    for (const name of [...OWNER_ONLY, "intent"]) {
      expect(callable).not.toContain(name);
    }
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
