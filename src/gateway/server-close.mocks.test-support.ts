import { vi } from "vitest";
import type { InternalHookEvent } from "../hooks/internal-hooks.js";

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
}));

export { mocks };

vi.mock("../channels/plugins/index.js", async () => ({
  ...(await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  )),
  listChannelPlugins: mocks.listChannelPlugins,
}));

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
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

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
vi.mock("../agents/harness/registry.js", () => ({
  disposeRegisteredAgentHarnesses: mocks.disposeAgentHarnesses,
}));

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
vi.mock("../agents/code-mode-state.js", () => ({
  disposeAllCodeModeRuns: mocks.disposeAllCodeModeRuns,
}));

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
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

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
vi.mock("./embeddings-provider-lifetime.js", () => ({
  drainRetainedOpenAiEmbeddingProviders: mocks.drainRetainedEmbeddingProviders,
}));

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
vi.mock("../agents/session-suspension.js", () => ({
  fenceSessionSuspensionWritesForGatewayShutdown:
    mocks.fenceSessionSuspensionWritesForGatewayShutdown,
}));

// mock-isolation: The shared Gateway fixture owns this unrelated shutdown effect.
vi.mock("../acp/control-plane/manager.js", () => ({
  disposeAcpSessionManager: mocks.disposeAcpSessionManager,
}));

// Fork: the post-shutdown exit-watchdog suite (server-close.exit-watchdog.test.ts) resets
// the shared mocks through this helper; it mocks the subsystem logger itself, as
// server-close.test.ts does.
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
  ]) {
    mock.mockReset();
    mock.mockResolvedValue(undefined);
  }
}
