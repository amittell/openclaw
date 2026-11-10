import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createOpenClawCodingTools } from "../../agents/agent-tools.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { buildEmbeddedAttemptToolRunContext } from "../../agents/embedded-agent-runner/run/attempt-tool-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as sessionEvents from "./session-event-handoff.js";

// mock-isolation: Only model inference is synthetic; exec, its completion admission and tool policy stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
// The real Discord plugin owns guild policy, which it selects by guild id and channel name.
const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
  pluginId: "discord",
  artifactBasename: "channel-plugin-api.ts",
});
// A live Gateway registers Discord's binding adapter when an account starts; no account runs
// here, so the fixture keeps only the plugin's real guild policy.
const { conversationBindings: _unstartedBindings, ...discordGuildPolicy } = discordPlugin;

// #177510: the requester is allowed exec only by their own toolsBySender entry; "*" denies it.
const REQUESTER = "100001";
const GUEST = "100002";
const ACCOUNT = "requester-account";
const GUILD = "200001";
const CHANNEL = "300001";
const conversations = {
  dm: {
    sessionKey: `agent:main:telegram:direct:${REQUESTER}`,
    chatType: "direct",
    route: { channel: "telegram", to: `telegram:${REQUESTER}`, accountId: ACCOUNT },
    group: {},
  },
  guild: {
    sessionKey: `agent:main:discord:channel:${CHANNEL}`,
    chatType: "channel",
    route: { channel: "discord", to: `channel:${CHANNEL}`, accountId: ACCOUNT },
    group: { groupSpace: GUILD, groupChannel: "ops" },
  },
} as const;
const denyExec = { deny: ["exec"] };

function policy(revoke?: "sender" | "guild", commandOwner?: true): OpenClawConfig {
  return {
    ...(commandOwner ? { commands: { ownerAllowFrom: [REQUESTER] } } : {}),
    ...(revoke === "guild"
      ? { channels: { discord: { guilds: { [GUILD]: { tools: denyExec } } } } }
      : {}),
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      exec: { host: "gateway", mode: "full" },
      toolsBySender: {
        [`id:${REQUESTER}`]: revoke === "sender" ? denyExec : {},
        "*": { deny: ["exec", "process", "nodes", "gateway"] },
      },
    },
  };
}

type Row = {
  label: string;
  /** "exec" launches a real background command from the requester's own coding tools. */
  start: "exec" | "capture";
  requester?: string;
  on?: "guild";
  /** Where the starting turn ran, when it is not this session's own conversation. */
  startTo?: string;
  revoke?: "sender" | "guild";
  commandOwner?: true;
  outcome: "ran" | "absent";
};
const rows: Row[] = [
  { label: "requester's own DM", start: "exec", requester: REQUESTER, outcome: "ran" },
  {
    label: "requester who is a command owner",
    start: "exec",
    requester: REQUESTER,
    commandOwner: true,
    outcome: "ran",
  },
  // A command started in another chat completes in this session senderless: the route differs.
  {
    label: "started in another chat",
    start: "exec",
    requester: REQUESTER,
    startTo: "telegram:-100200",
    outcome: "absent",
  },
  { label: "a different sender", start: "capture", requester: GUEST, outcome: "absent" },
  { label: "no captured sender", start: "capture", outcome: "absent" },
  {
    label: "requester's entry revoked before completion",
    start: "capture",
    requester: REQUESTER,
    revoke: "sender",
    outcome: "absent",
  },
  {
    label: "Discord guild channel",
    start: "capture",
    requester: REQUESTER,
    on: "guild",
    outcome: "ran",
  },
  {
    label: "guild deny added before completion",
    start: "capture",
    requester: REQUESTER,
    on: "guild",
    revoke: "guild",
    outcome: "absent",
  },
];

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

/** Admits the completion turn and opens its real managed tool host with shell tools. */
async function openCompletionTools(params: RunEmbeddedAgentParams) {
  const admittedRunContext = await expectDefined(
    params.preparedRunAdmission,
    "completion admission",
  ).admit("gateway", params.runId);
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  const workspace = await resolveAttemptWorkspaceSandbox({ ...params, admittedRunContext });
  const host = createAgentHarnessHostCapabilities({
    attempt: {
      admittedRunContext,
      runId: params.runId,
      abortSignal: params.abortSignal,
      config: params.config,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      permissionMode: params.permissionMode,
      requireWorkspaceOnly: params.requireWorkspaceOnly,
      sessionRoot: workspace.sessionPermissionRoot,
      workspaceDir: params.workspaceDir,
      bootstrapWorkspaceDir: params.bootstrapWorkspaceDir,
      cwd: params.cwd,
      sandboxAgentId: params.sandboxAgentId,
      skillsSnapshot: params.skillsSnapshot,
      toolExecutionAllow: params.toolExecutionAllow,
      toolsAllow: params.toolsAllow,
      runtimePluginToolGrant: params.runtimePluginToolGrant,
      trigger: params.trigger,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      agentAccountId: params.agentAccountId,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
    },
    pluginId: "openclaw",
  });
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...params,
    model:
      params.provider && params.model ? { provider: params.provider, id: params.model } : undefined,
  });
  const construction = resolveEmbeddedAttemptToolConstructionPlan({
    toolsAllow: toolRunContext.runtimeToolAllowlist,
  });
  const tools = applyEmbeddedAttemptToolsAllow(
    expectDefined(
      host.capabilities.createToolSurface,
      "managed tool surface",
    )({
      ...toolRunContext,
      config: params.config,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: workspace.effectiveWorkspace,
      cwd: workspace.effectiveCwd,
      sessionPermissionPolicy: workspace.sessionPermissionPolicy,
      toolConstructionPlan: {
        ...construction.codingToolConstructionPlan,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    }),
    construction.runtimeToolAllowlist,
  );
  return { tools, close: () => host.close() };
}

it.for(rows)(
  "runs completion-side exec only under the requester's own current policy: $label",
  async (row, { signal, onTestFinished }) => {
    const { sessionKey, chatType, route, group } = conversations[row.on ?? "dm"];
    const work = withOpenClawTestState(
      { label: "session-event-exec-requester", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const registry = captureActivePluginRegistrySnapshot();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordGuildPolicy }]),
        );
        const receipts: sessionEvents.SessionEventReceipt[] = [];
        const enqueue = sessionEvents.enqueueSessionEventForHost;
        vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation(
          (text, options) => {
            const receipt = enqueue(text, options);
            receipts.push(receipt);
            return receipt;
          },
        );
        onTestFinished(() => {
          restoreActivePluginRegistrySnapshot(registry);
          vi.restoreAllMocks();
          resetProcessRegistryForTests();
          resetSystemEventsForTest();
        });
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
          ...policy(undefined, row.commandOwner),
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        await fs.mkdir(state.workspaceDir, { recursive: true });
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "exec-requester",
            permissionMode: "full",
            updatedAt: Date.now(),
            sessionStartedAt: Date.now(),
            chatType,
            delivery: {
              kind: "external",
              route: { channel: route.channel, accountId: ACCOUNT, target: { to: route.to } },
              context: route,
              origin: { provider: route.channel, chatType, accountId: ACCOUNT },
            },
          },
        );
        const marker = path.join(state.workspaceDir, "completion-exec.txt");
        const seen: { offered?: boolean; read?: boolean; outcome?: string; owner?: boolean } = {};
        const completionRan = createDeferred();
        model.mockReset().mockImplementation(async (params) => {
          const { tools, close } = await openCompletionTools(params);
          const exec = tools.find((tool) => tool.name === "exec");
          seen.offered = Boolean(exec);
          seen.read = tools.some((tool) => tool.name === "read");
          seen.owner = params.senderIsOwner;
          seen.outcome = await (
            exec
              ? exec
                  .execute("completion-exec", {
                    command: nodeCommand(
                      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`,
                    ),
                  })
                  .then(
                    () => "ran",
                    (error: unknown) => (error instanceof Error ? error.message : String(error)),
                  )
              : Promise.resolve("absent")
          ).finally(close);
          completionRan.resolve();
          return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
        });

        if (row.start === "exec") {
          // The requester's own turn launches the command through its coding tools. That DM's
          // own policy denies read, and the completion must keep that restriction.
          const startExec = expectDefined(
            createOpenClawCodingTools({
              config,
              agentId: "main",
              sessionKey,
              workspaceDir: state.workspaceDir,
              sessionPermissionPolicy: { root: state.workspaceDir, mode: "full" },
              exec: { host: "gateway", mode: "full", notifyOnExit: true },
              trigger: "user",
              messageProvider: route.channel,
              agentAccountId: ACCOUNT,
              currentChannelId: row.startTo ?? route.to,
              chatType,
              senderId: row.requester,
              senderName: "Alice",
              senderUsername: "alice",
              conversationToolPolicy: { deny: ["read"] },
            }).find((tool) => tool.name === "exec"),
            "requester's exec",
          );
          const started = await startExec.execute("start-exec", {
            command: nodeCommand('process.stdout.write("BACKGROUND_DONE")'),
            background: true,
          });
          expect(started.details).toMatchObject({ status: "running" });
          await withinTest(completionRan.promise, signal);
        } else {
          // The capture exec makes at launch, for a turn in this session's own conversation.
          const target = await sessionEvents.captureSessionEventTargetForHost(
            "main",
            sessionKey,
            row.requester
              ? {
                  requester: {
                    route,
                    senderId: row.requester,
                    senderName: "Alice",
                    senderUsername: "alice",
                    chatType,
                    ...group,
                  },
                }
              : {},
          );
          if (row.revoke) {
            setRuntimeConfigSnapshot({ ...config, ...policy(row.revoke, row.commandOwner) });
          }
          sessionEvents.enqueueSessionEventForHost("Exec completed (exec-1, code 0)", {
            agentId: "main",
            sessionKey,
            source: "exec",
            expectedTarget: target,
            deliveryContext: route,
            abortSignal: signal,
          });
        }
        const receipt = expectDefined(receipts.at(-1), "exec completion receipt");
        const settled = await withinTest(receipt.settled, signal);
        expect(settled, JSON.stringify(settled)).toMatchObject({ status: "completed" });
        const ran = await fs.readFile(marker, "utf8").then(
          (text) => text === "ran",
          () => false,
        );
        // A restored requester keeps their DM's own restriction (read) and is never an owner.
        const restoredDm = row.start === "exec" && row.outcome === "ran";
        const { read, ...observed } = seen;
        expect({ ...observed, ...(restoredDm ? { read } : {}), ran }).toEqual({
          offered: row.outcome === "ran",
          ...(restoredDm ? { read: false } : {}),
          outcome: row.outcome,
          owner: false,
          ran: row.outcome === "ran",
        });
      },
    );
    onTestFinished(async () => {
      await Promise.allSettled([work]);
    });
    await work;
  },
);
