// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { resetMessageToolSendSuppressionForTest } from "../src/agents/tools/message-tool-execution.send-suppression.js";
import { installSharedTestSetup } from "./setup.shared.js";

const codexAppServerTestPattern = /\/extensions\/codex\/src\/app-server\/.*\.test\.ts$/;
if (codexAppServerTestPattern.test(expect.getState().testPath?.replaceAll("\\", "/") ?? "")) {
  // Prepare declarations before collection without binding worker-cpu ahead of file mocks.
  await import("../src/test-utils/prepare-compiled-subprocesses.js");
}

const testEnv = installSharedTestSetup({ loadProfileEnv: false });
let restoreUpstreamLinks: (() => void) | undefined;

beforeEach(async (context) => {
  vi.useRealTimers();
  // FORK ADDITION (upstream carries this file unmodified; keep the diff to these
  // two lines so a future carry can re-apply it mechanically).
  //
  // The fork's duplicate-send guard keeps process-global state keyed by runId
  // (src/agents/tools/message-tool-execution.send-suppression.ts). That key is
  // deliberately per-RUN and not per-tool-instance, because the message tool is
  // rebuilt for every attempt (run/attempt-tool-prepare.ts) and a re-narration
  // spanning two attempts of one run is exactly the pathology the guard exists
  // to catch. Scoping the map to the instance would silently break that.
  //
  // The consequence is that a suite reusing one runId across logically distinct
  // cases carries sends from one into the next and suppresses them - which is
  // what upstream's dynamic-tool-build.test.ts does (runId "run-1" for every
  // it.each case, identical text), so its later cases never reach the TTS path
  // and synthesize is called 0 times where 1 is expected. Clearing the trackers
  // between tests fixes it without touching the guard or any upstream assertion.
  resetMessageToolSendSuppressionForTest();
  const testPath = expect.getState().testPath?.replaceAll("\\", "/");
  if (codexAppServerTestPattern.test(testPath ?? "")) {
    const { getTrackedWorkerPoolSnapshot } = await vi.importActual<
      typeof import("../src/infra/worker-cpu.js")
    >("../src/infra/worker-cpu.js");
    let stop: (() => Promise<void>) | undefined;
    context.codexAttemptRuntime = {
      readWorkerPools: getTrackedWorkerPoolSnapshot,
      start: async () => {
        const [mcp, clocks] = await Promise.all([
          vi.importActual<typeof import("../src/agents/agent-bundle-mcp-manager-api.js")>(
            "../src/agents/agent-bundle-mcp-manager-api.js",
          ),
          vi.importActual<typeof import("../src/test-utils/gateway-scheduler-clock.js")>(
            "../src/test-utils/gateway-scheduler-clock.js",
          ),
        ]);
        const scheduler = clocks.createTestGatewayScheduler();
        stop = async () => {
          scheduler.beginClose();
          try {
            await mcp.disposeAllSessionMcpRuntimes();
          } finally {
            await scheduler.stop();
          }
        };
        await mcp.setSessionMcpRuntimeScheduler(scheduler);
      },
      stop: async () => {
        await stop?.();
      },
    };
  }
  if (
    !testPath?.match(
      /\/extensions\/codex\/src\/app-server\/upstream-(?:fork-import|session-fork|session-fork-continuation)\.test\.ts$/,
    )
  ) {
    return;
  }
  // Shared initialization calls the core owner; extension fixtures keep their public SDK mocks.
  const [owner, facade] = await Promise.all([
    vi.importActual<typeof import("../src/sessions/session-upstream-links.js")>(
      "../src/sessions/session-upstream-links.js",
    ),
    vi.importMock<typeof import("openclaw/plugin-sdk/session-catalog")>(
      "openclaw/plugin-sdk/session-catalog",
    ),
  ]);
  const upsert = vi
    .spyOn(owner, "upsertSessionUpstreamLinkWithCurrentSource")
    .mockImplementation((input, options) => facade.upsertSessionUpstreamLinkAsync(input, options));
  const remove = vi
    .spyOn(owner, "deleteSessionUpstreamLinkAsync")
    .mockImplementation(facade.deleteSessionUpstreamLinkAsync);
  restoreUpstreamLinks = () => {
    upsert.mockRestore();
    remove.mockRestore();
  };
});

afterEach(() => {
  restoreUpstreamLinks?.();
  restoreUpstreamLinks = undefined;
});

afterAll(async () => {
  const { drainAgentDatabaseResources } = await vi.importActual<
    typeof import("../src/state/openclaw-agent-db-resources.js")
  >("../src/state/openclaw-agent-db-resources.js");
  // File-owned homes must survive until retained Worker leases have been released.
  await drainAgentDatabaseResources({}, async () => {
    const { drainGlobalSingletonLifecycleState } = await vi.importActual<
      typeof import("../src/shared/global-singleton.js")
    >("../src/shared/global-singleton.js");
    await drainGlobalSingletonLifecycleState();
    testEnv.cleanup();
  });
});
