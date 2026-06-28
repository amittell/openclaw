// Subagent spawn model-session tests verify runtime model metadata is persisted
// before a child agent run starts.
import os from "node:os";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();
const pruneLegacyStoreKeysMock = vi.fn();

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;

describe("spawnSubagentDirect runtime model persistence", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      updateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    }));
  });

  beforeEach(() => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    pruneLegacyStoreKeysMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);

    updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  it("persists runtime model fields on the child session before starting the run", async () => {
    // The child run reads model/provider from session state, so persistence must
    // happen before the gateway accepts the agent request.
    const operations: string[] = [];
    callGatewayMock.mockImplementation(async (opts: { method?: string }) => {
      operations.push(`gateway:${opts.method ?? "unknown"}`);
      if (opts.method === "sessions.patch") {
        return { ok: true };
      }
      if (opts.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
      }
      if (opts.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "test",
        model: "openai/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.resolvedModel).toBe("openai/gpt-5.4");
    expect(result.resolvedProvider).toBe("openai");
    expect(updateSessionStoreMock).toHaveBeenCalledTimes(3);
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "openai",
      model: "gpt-5.4",
      overrideSource: "user",
    });
    expect(pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(3);
    expect(operations.indexOf("store:update")).toBeGreaterThan(-1);
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(
      operations.lastIndexOf("store:update"),
    );
  });

  it("persists self-origin metadata for auto-selected subagent models", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForAutoModelTest,
      spawnSubagentDirect: spawnWithAutoModel,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "gpt-5.4" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    });
    resetForAutoModelTest();
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    installSessionStoreCaptureMock(dedicatedUpdateSessionStoreMock, {
      onStore: (store) => {
        persistedStore = store;
      },
    });

    const result = await spawnWithAutoModel(
      {
        task: "test",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.modelOverrideSource).toBe("auto");
    expect(persistedEntry?.modelOverrideFallbackOriginProvider).toBe("openai");
    expect(persistedEntry?.modelOverrideFallbackOriginModel).toBe("gpt-5.4");
  });

  it("re-applies execution override fields during final runtime model persistence", async () => {
    const dedicatedUpdateSessionStoreMock = vi.fn();
    const {
      resetSubagentRegistryForTests: resetForRuntimeRestoreTest,
      spawnSubagentDirect: spawnWithConfiguredModel,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () =>
        createSubagentSpawnTestConfig(os.tmpdir(), {
          agents: {
            defaults: {
              workspace: os.tmpdir(),
              model: { primary: "openai/gpt-5.5" },
              subagents: { model: "kebab-rtx6000/qwen3.6-27b" },
            },
          },
        }),
      updateSessionStoreMock: dedicatedUpdateSessionStoreMock,
      pruneLegacyStoreKeysMock,
      workspaceDir: os.tmpdir(),
    });
    resetForRuntimeRestoreTest();

    const store: Record<string, Record<string, unknown>> = {};
    let updateCount = 0;
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    dedicatedUpdateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        updateCount += 1;
        await mutator(store);
        if (updateCount === 1) {
          const [, entry] = Object.entries(store)[0] ?? [];
          if (entry) {
            delete entry.providerOverride;
            delete entry.modelOverride;
            delete entry.modelOverrideSource;
            delete entry.modelOverrideFallbackOriginProvider;
            delete entry.modelOverrideFallbackOriginModel;
          }
        }
        persistedStore = store;
        return store;
      },
    );

    const result = await spawnWithConfiguredModel(
      {
        task: "test",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "guildchat",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.resolvedModel).toBe("kebab-rtx6000/qwen3.6-27b");
    expectPersistedRuntimeModel({
      persistedStore,
      sessionKey: /^agent:main:subagent:/,
      provider: "kebab-rtx6000",
      model: "qwen3.6-27b",
      overrideSource: "auto",
    });
    const [, persistedEntry] = Object.entries(persistedStore ?? {})[0] ?? [];
    expect(persistedEntry?.modelOverrideFallbackOriginProvider).toBe("kebab-rtx6000");
    expect(persistedEntry?.modelOverrideFallbackOriginModel).toBe("qwen3.6-27b");
  });
});
