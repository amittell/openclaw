import { vi } from "vitest";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";

// Module mocks shared by the close-lifecycle suites; import this file first so the
// mocks register before any module under test loads.
type TriggerInternalHookMock = (event: InternalHookEvent) => Promise<void>;

const mocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  listChannelPlugins: vi.fn((): Array<{ id: "telegram" | "discord" }> => []),
  disposeAllCodeModeRuns: vi.fn(),
  disposeAgentHarnesses: vi.fn<() => Promise<void>>(async () => undefined),
  closeProviderTransportDispatcherPool: vi.fn(async () => undefined),
  disposeAllSessionMcpRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  triggerInternalHook: vi.fn<TriggerInternalHookMock>(async (_eventValue) => undefined),
  disposeAllBundleLspRuntimes: vi.fn<() => Promise<void>>(async () => undefined),
  drainRetainedEmbeddingProviders: vi.fn<() => Promise<void>>(async () => undefined),
  stopGmailWatcher: vi.fn(async () => undefined),
  disposeAcpSessionManager: vi.fn(async (_reason: string) => undefined),
  fenceSessionSuspensionWritesForGatewayShutdown: vi.fn(),
  closePluginStateDatabaseAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: mocks.listChannelPlugins,
}));

// mock-isolation: Observe watcher shutdown without touching a real Gmail watcher process.
vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: mocks.stopGmailWatcher,
}));

vi.mock("../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/internal-hooks.js")>(
    "../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook: mocks.triggerInternalHook,
  };
});

// mock-isolation: Observe harness disposal without disposing harnesses from the active plugin registry.
vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

// mock-isolation: Observe code-mode disposal without the process-global code-mode run state.
vi.mock("../agents/code-mode-state.js", () => ({
  disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
}));

// mock-isolation: Observe pool shutdown without closing the shared provider transport dispatchers.
vi.mock("../agents/provider-transport-dispatcher-pool.js", () => ({
  closeProviderTransportDispatcherPool: mocks.closeProviderTransportDispatcherPool,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-mcp-tools.js")>(
    "../agents/agent-bundle-mcp-tools.js",
  )),
  disposeAllSessionMcpRuntimes: mocks.disposeAllSessionMcpRuntimes,
}));

vi.mock("../agents/agent-bundle-lsp-runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-bundle-lsp-runtime.js")>(
    "../agents/agent-bundle-lsp-runtime.js",
  )),
  disposeAllBundleLspRuntimes: mocks.disposeAllBundleLspRuntimes,
}));

// mock-isolation: Observe the embedding drain without module-level provider admission state.
vi.mock("./embeddings-provider-lifetime.js", () => ({
  drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
}));

// mock-isolation: Observe the shutdown write fence without real session-suspension state.
vi.mock("../agents/session-suspension.js", () => ({
  fenceSessionSuspensionWritesForGatewayShutdown:
    mocks.fenceSessionSuspensionWritesForGatewayShutdown,
}));

// mock-isolation: Observe ACP disposal without the real ACP session-manager singleton.
vi.mock("../acp/control-plane/manager.js", () => ({
  disposeAcpSessionManager: mocks.disposeAcpSessionManager,
}));

vi.mock("../plugin-state/plugin-state-store.js", async () => ({
  ...(await vi.importActual<typeof import("../plugin-state/plugin-state-store.js")>(
    "../plugin-state/plugin-state-store.js",
  )),
  closePluginStateDatabaseAsync: mocks.closePluginStateDatabaseAsync,
}));

// mock-isolation: Capture close-path log lines without the real subsystem logger sinks.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: mocks.logInfo,
    warn: mocks.logWarn,
  })),
}));

export { mocks };

export function resetServerCloseMocks(): void {
  mocks.logInfo.mockClear();
  mocks.logWarn.mockClear();
  mocks.listChannelPlugins.mockReset();
  mocks.listChannelPlugins.mockReturnValue([]);
  mocks.disposeAllCodeModeRuns.mockReset();
  mocks.fenceSessionSuspensionWritesForGatewayShutdown.mockReset();
  // A reset, not a clear: leftover once-implementations must not leak between tests (#166014).
  for (const mock of [
    mocks.disposeAgentHarnesses,
    mocks.disposeAllSessionMcpRuntimes,
    mocks.triggerInternalHook,
    mocks.disposeAllBundleLspRuntimes,
    mocks.drainRetainedEmbeddingProviders,
    mocks.stopGmailWatcher,
    mocks.closeProviderTransportDispatcherPool,
    mocks.disposeAcpSessionManager,
    mocks.closePluginStateDatabaseAsync,
  ]) {
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
}
