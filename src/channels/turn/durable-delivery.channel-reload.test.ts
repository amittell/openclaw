import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { diffGatewayReloadPaths } from "../../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../../gateway/config-reload-plan.js";
import { createDefaultGatewayReloadState } from "../../gateway/server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "../../gateway/server-reload-hot.js";
import {
  bindPluginRegistryGatewayOwner,
  getPluginRegistryGatewayOwner,
} from "../../plugins/registry-lifecycle.js";
import {
  createPluginRegistryOwner,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeLoadContext,
  setPluginRuntimeLoadContext,
} from "../../plugins/runtime/load-context.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { ChannelPlugin } from "../plugins/types.js";
import { withDurableDeliveryRuntime } from "./durable-delivery-runtime.js";

// Incident shape (mac-mini, 2026-10-07): a bot edited one group's systemPrompt in openclaw.json.
const GROUP = "-1001125402299";

function withGroupSystemPrompt(cfg: OpenClawConfig, systemPrompt: string): OpenClawConfig {
  const next = structuredClone(cfg);
  const telegram = (next.channels ??= {}).telegram ?? {};
  next.channels.telegram = telegram;
  const account = telegram.accounts?.default ?? telegram;
  account.groups = { ...account.groups, [GROUP]: { ...account.groups?.[GROUP], systemPrompt } };
  return next;
}

function bindStartupLoadContext(
  registry: Parameters<typeof setPluginRuntimeLoadContext>[0],
  cfg: OpenClawConfig,
) {
  // Mirrors src/gateway/server-startup-plugins.ts: the Gateway registry records the config it started with.
  setPluginRuntimeLoadContext(registry, {
    rawConfig: cfg,
    config: cfg,
    activationSourceConfig: cfg,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

const { telegramSetupPlugin } = await loadBundledPluginFacade<{
  telegramSetupPlugin: ChannelPlugin;
}>({ artifactBasename: "setup-plugin-api", pluginId: "telegram" });

describe("channel-only hot reload of channels.telegram (gateway layer)", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
  });

  it.each([
    ["group systemPrompt (channel-restart class)", "systemPrompt"],
    ["account allowFrom (live-read noop class)", "allowFrom"],
  ] as const)(
    "edit of %s: no registry republish or load-config refresh; later turn's final reply",
    async (_label, edit) => {
      const before: OpenClawConfig = {
        channels: {
          telegram: {
            enabled: true,
            accounts: {
              default: { botToken: "123:startup", groups: { [GROUP]: { systemPrompt: "v0" } } },
              ratbot: { botToken: "456:startup" },
            },
          },
        },
      };
      const after =
        edit === "systemPrompt"
          ? withGroupSystemPrompt(before, "v1")
          : (() => {
              const next = structuredClone(before);
              next.channels!.telegram!.accounts!.default!.allowFrom = ["484946046"];
              return next;
            })();
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", plugin: telegramSetupPlugin, source: "bundled" },
        ]),
      );
      const startup = getActivePluginRegistry();
      if (!startup) {
        throw new Error("expected the startup registry");
      }
      const owner = createPluginRegistryOwner(startup);
      bindStartupLoadContext(startup, before);
      setRuntimeConfigSnapshot(before, before);

      const plan = buildGatewayReloadPlan(
        diffGatewayReloadPaths(before, after, listConfigReloadRefinementPrefixes()),
        { previousConfig: before, candidateConfig: after },
      );
      expect(plan.restartGateway).toBe(false);
      expect(plan.reloadPlugins).toBe(false);
      if (edit === "systemPrompt") {
        expect(plan.changedPaths).toEqual([
          `channels.telegram.accounts.default.groups.${GROUP}.systemPrompt`,
        ]);
        expect([...plan.restartChannels]).toEqual(["telegram"]);
      } else {
        expect(plan.restartChannels.size).toBe(0);
        expect(plan.noopPaths).toEqual(["channels.telegram.accounts.default.allowFrom"]);
      }

      let state = createDefaultGatewayReloadState();
      const stopChannel = vi.fn(async () => {});
      const startChannel = vi.fn(async () => new Map());
      const reloadPlugins = vi.fn(async () => {
        throw new Error("a channel-only edit must not reload plugins");
      });
      const { applyHotReload } = createGatewayReloadHandlers({
        scheduler: createTestGatewayScheduler("fake-timers"),
        deps: {} as never,
        broadcast: vi.fn(),
        getState: () => state,
        setState: (next) => {
          state = next;
        },
        getPluginRegistry: () => owner.registry,
        startChannel,
        stopChannel,
        releaseChannelRouteHandoffs: vi.fn(),
        pruneInactiveChannelAccountState: vi.fn(),
        reloadPlugins,
        logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        logChannels: { info: vi.fn(), error: vi.fn() },
        logCron: { error: vi.fn() },
        logReload: { info: vi.fn(), warn: vi.fn() },
        cronReconciliation: {
          arm: vi.fn(() => ({ complete: async () => {} })),
          invalidate: vi.fn(),
        },
        // The managed Gateway always has a restart owner; this plan must not use it.
        requestRecoveryRestart: vi.fn(() => {
          throw new Error("a channel-only edit must not request a Gateway restart");
        }) as never,
      });
      await expect(applyHotReload(plan, after)).resolves.toBe("applied");
      // The managed reloader then publishes the accepted config as the runtime snapshot.
      setRuntimeConfigSnapshot(after, after);

      expect(reloadPlugins).not.toHaveBeenCalled();
      if (edit === "systemPrompt") {
        expect(stopChannel).toHaveBeenCalledWith("telegram", undefined, expect.anything());
        expect(startChannel).toHaveBeenCalledWith("telegram", undefined, expect.anything());
      } else {
        expect(stopChannel).not.toHaveBeenCalled();
      }
      // The Gateway publication and the config it was loaded with are both unchanged.
      expect(owner.registry).toBe(startup);
      expect(getPluginRuntimeLoadContext(startup)?.rawConfig).toBe(before);

      // A turn admitted AFTER the reload: the restarted monitor runs under the Gateway registry,
      // dispatch loads a turn registry bound like runtime-plugins.ts bindAdmittingGateway, and
      // the turn's cfg is the live runtime config (bot-handlers.message-pipeline.ts).
      const turnRegistry = createTestRegistry([]);
      const gatewayOwner = getPluginRegistryGatewayOwner(startup);
      if (!gatewayOwner) {
        throw new Error("expected the Gateway owner");
      }
      bindPluginRegistryGatewayOwner(turnRegistry, gatewayOwner, startup);
      const turnCfg = getRuntimeConfigSnapshot();
      expect(turnCfg).toBe(after);

      const deliver = vi.fn((_cfg: OpenClawConfig) => "sent");
      const finalReply = () =>
        withPluginRuntimeRegistryScope(turnRegistry, () =>
          withDurableDeliveryRuntime(
            { cfg: turnCfg ?? {}, channel: "telegram", prepareRuntimeHandoff: (cfg) => cfg },
            deliver,
          ),
        );
      // 2026-10-07 regression: every later final reply was rejected with "cannot preserve its sender".
      expect(finalReply()).toBe("sent");
      expect(deliver).toHaveBeenCalledOnce();
      await owner.close();
    },
  );
});

type TelegramDispatchHttpFixture = {
  token: string;
  calls: Array<{ method: string; fields: Record<string, unknown> }>;
  visibleMessages: Map<number, string>;
  dispatchProgressTurn: (
    emitEvents: () => Promise<void>,
    scenario: {
      mode: "off";
      toolProgress: boolean;
      finalReply: { text: string };
      allowErrors: boolean;
      telegramCfg: Record<string, unknown>;
      onDispatch: (config: OpenClawConfig) => void;
    },
  ) => Promise<unknown>;
};

const { createTelegramDispatchHttpFixture } = await loadBundledPluginFacade<{
  createTelegramDispatchHttpFixture: () => TelegramDispatchHttpFixture;
}>({ pluginId: "telegram", artifactBasename: "dispatch.test-api.js" });

describe("Telegram DM final reply after a channels.telegram group edit (real dispatch)", () => {
  const http = createTelegramDispatchHttpFixture();
  afterEach(() => vi.unstubAllEnvs());

  it.each(["startup-config", "edited-after-startup"] as const)(
    "turn admitted with %s",
    async (gatewayLoadConfig) => {
      const finalText = `final reply (${gatewayLoadConfig})`;
      const gatewayRegistry = getActivePluginRegistry();
      if (!gatewayRegistry) {
        throw new Error("Expected the fixture's Telegram registry");
      }
      const owner = createPluginRegistryOwner(gatewayRegistry);
      vi.stubEnv("TELEGRAM_BOT_TOKEN", http.token);
      try {
        // The monitor dispatches under its Gateway registry (server-channels.ts withRegistry);
        // dispatchReplyFromConfig then runs the turn in its own agent registry.
        // allowErrors=false: the fixture asserts its runtime.error log is empty, so a rejected
        // final surfaces here with the exact production log text.
        const dispatched = withPluginRuntimeRegistryScope(gatewayRegistry, () =>
          http.dispatchProgressTurn(async () => {}, {
            mode: "off",
            toolProgress: false,
            finalReply: { text: finalText },
            allowErrors: false,
            // The turn reads the live config: an unrelated group's prompt was edited.
            telegramCfg: { groups: { [GROUP]: { systemPrompt: "edited by a bot" } } },
            onDispatch(turnConfig) {
              bindStartupLoadContext(
                gatewayRegistry,
                gatewayLoadConfig === "startup-config"
                  ? turnConfig
                  : withGroupSystemPrompt(turnConfig, "as the Gateway started"),
              );
            },
          }),
        );
        await dispatched;
        const finals = http.calls.filter(
          (call) => call.method === "sendMessage" && call.fields.text === finalText,
        );
        expect(finals).toHaveLength(1);
      } finally {
        await owner.close();
      }
    },
  );
});
