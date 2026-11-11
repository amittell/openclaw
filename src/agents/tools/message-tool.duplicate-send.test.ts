// Duplicate-send guard tests: a near-identical resend within one run is
// suppressed, while later runs and media sends with a repeated caption deliver.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import type { runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createMessageTool } from "./message-tool-execution.js";
import { createChannelPlugin } from "./message-tool.test-support.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  resolveCommandSecretRefsViaGateway: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    diagnostics: [],
  })),
  // The runtime config above is empty, so every scoped lookup has no secret targets.
  getScopedChannelsCommandSecretTargets: vi.fn(() => ({ targetIds: new Set<string>() })),
}));

vi.mock("../../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../../channels/plugins/bundled.js")>(
    "../../channels/plugins/bundled.js",
  );
  // This suite installs a minimal loaded plugin; bundled source entries stay unloaded.
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
    getBundledChannelSetupPlugin: vi.fn(() => undefined),
  };
});

vi.mock("../../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/message-action-runner.js")
  >("../../infra/outbound/message-action-runner.js");
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.getRuntimeConfig,
  };
});

// mock-isolation: Secret refs pass through unchanged so no Gateway secrets RPC is made.
vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

// mock-isolation: Keep channel secret contracts and plugin provider discovery out of target lookup.
vi.mock("../../cli/command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
}));

vi.mock("../../channels/plugins/message-tool-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/message-tool-api.js")>()),
  resolveBundledChannelMessageToolDiscoveryAdapter: () => ({
    describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
  }),
}));

type RunMessageActionInput = Parameters<typeof runMessageAction>[0];

function lastRunMessageActionInput(): RunMessageActionInput | undefined {
  return mocks.runMessageAction.mock.calls.at(-1)?.[0] as RunMessageActionInput | undefined;
}

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetDiagnosticSessionStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.getRuntimeConfig.mockReset().mockReturnValue({});
});

afterEach(() => {
  resetGlobalHookRunner();
});

describe("duplicate send guard", () => {
  const currentChat = "iMessage;-;+15550001111";
  let runCounter = 0;

  // The guard is keyed strictly by runId so intra-run re-narration is caught
  // while a later run may legitimately repeat the same answer.
  function createSendTool(runId?: string) {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createChannelPlugin({ id: "imessage" }),
        },
      ]),
    );
    mocks.runMessageAction.mockImplementation(
      async () =>
        ({
          kind: "send",
          channel: "imessage",
          action: "send",
          to: currentChat,
          handledBy: "plugin",
          payload: { ok: true },
          dryRun: false,
        }) as MessageActionResult,
    );
    return createMessageTool({
      currentChannelProvider: "imessage",
      currentChannelId: currentChat,
      agentAccountId: "primary",
      agentSessionKey: "agent:test:imessage:direct:dup-guard",
      runId: runId ?? `run-dup-${(runCounter += 1)}`,
      sourceReplyDeliveryMode: "message_tool_only",
      runMessageAction: mocks.runMessageAction as never,
    });
  }

  it("suppresses a near-duplicate resend within the same run", async () => {
    const tool = createSendTool();
    const first = await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: "Restock alert: flux stock is 37 units, reorder soon.",
    });
    expect(first.details).not.toMatchObject({ status: "suppressed" });

    const second = await tool.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: "FYI — Restock alert: flux stock is 37 units, reorder soon. Please action.",
    });
    expect(second.details).toMatchObject({ status: "suppressed", reason: "duplicate_send" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(1);
  });

  it("delivers distinct texts in the same run", async () => {
    const tool = createSendTool();
    await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: "Restock alert: flux stock is 37 units, reorder soon.",
    });
    const second = await tool.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: "Separately: the widget count is healthy at 120 units.",
    });
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
  });

  it("does not suppress the same text in a different run", async () => {
    const first = createSendTool("run-dup-cross-a");
    await first.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: "Restock alert: flux stock is 37 units, reorder soon.",
    });
    const second = createSendTool("run-dup-cross-b");
    const result = await second.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: "Restock alert: flux stock is 37 units, reorder soon.",
    });
    expect(result.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
  });

  // Every media source the send path reads must bypass the guard: a captioned
  // attachment is a distinct deliverable, not a re-narration of its caption.
  it.each([
    { name: "a buffer data URL", media: { buffer: "data:image/png;base64,iVBORw0KGgo=" } },
    {
      name: "attachments[].media",
      media: { attachments: [{ media: "https://example.com/r.png" }] },
    },
    { name: "attachments[].path", media: { attachments: [{ path: "/tmp/restock.png" }] } },
    { name: "a mediaUrls array", media: { mediaUrls: ["https://example.com/r.png"] } },
    { name: "a bare mediaUrls string", media: { mediaUrls: "https://example.com/r.png" } },
    { name: "image", media: { image: "https://example.com/r.png" } },
    { name: "voiceText", media: { voiceText: "Flux stock is 37 units." } },
    { name: "media", media: { media: "https://example.com/r.png" } },
  ])("delivers a repeated caption sent with $name", async ({ media }) => {
    const tool = createSendTool();
    const caption = "Restock alert: flux stock is 37 units, reorder soon.";
    const first = await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: caption,
    });
    expect(first.details).not.toMatchObject({ status: "suppressed" });

    const second = await tool.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: caption,
      ...media,
    });
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
    expect(lastRunMessageActionInput()?.params).toMatchObject(media);
  });

  it("delivers consecutive buffer sends that share a caption", async () => {
    const tool = createSendTool();
    const caption = "Restock alert: flux stock is 37 units, reorder soon.";
    const first = await tool.execute("send-1", {
      action: "send",
      channel: "imessage",
      message: caption,
      buffer: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(first.details).not.toMatchObject({ status: "suppressed" });

    const second = await tool.execute("send-2", {
      action: "send",
      channel: "imessage",
      message: caption,
      buffer: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    });
    expect(second.details).not.toMatchObject({ status: "suppressed" });
    expect(mocks.runMessageAction).toHaveBeenCalledTimes(2);
  });
});
