// Session-level /temperature reaches the production attempt dispatch plan.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { buildAgentRuntimePlan } from "../../runtime-plan/build.js";
import { AuthStorage, ModelRegistry } from "../../sessions/index.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "./attempt-dispatch-preparation.js";
import { createEmbeddedRunStageTracker } from "./attempt-stage-timing.js";
import { createEmbeddedRunProgressController } from "./progress-controller.js";
import { dispatchEmbeddedRunAttempt } from "./run-attempt-dispatch.js";
import { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

vi.mock("../../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: vi.fn(),
  resolveSessionTranscriptRuntimeTarget: vi.fn(),
}));
vi.mock("../../../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions.js")>()),
  resolveSessionStorePathCore: vi.fn(() => "/temperature-test-store.json"),
}));
vi.mock("../../runtime-plan/build.js", () => ({
  buildAgentRuntimePlan: vi.fn(() => ({})),
}));
vi.mock("../../model-routing-decision.js", () => ({
  recordAdmittedModelRoutingDecision: vi.fn(),
}));
vi.mock("./run-attempt-dispatch.js", () => ({
  dispatchEmbeddedRunAttempt: vi.fn(async () => ({ kind: "dispatched" })),
}));

const mockedLoad = vi.mocked(loadSessionEntryReadOnly);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workspaceDir: string;
type DispatchInput = Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoad.mockReset();
  workspaceDir = tempDirs.make("temperature-dispatch-");
});

async function dispatch(params: { sessionKey?: string; storePath?: string } = {}) {
  const sessionKey = params.sessionKey ?? "agent:main:dm:1";
  const runParams: DispatchInput["runInput"]["runParams"] = {
    sessionId: "temperature-session",
    sessionFile: `${workspaceDir}/session.jsonl`,
    sessionPersistence: "detached",
    workspaceDir,
    prompt: "temperature proof",
    timeoutMs: 1_000,
    runId: "temperature-run",
    fastMode: false,
    config: { session: { store: params.storePath } },
    streamParams: { temperature: 0.3, topP: 0.9 },
  };
  const sessionPromptState = createEmbeddedRunSessionPromptState({
    runParams,
    sessionAgentId: "main",
    resolvedSessionKey: sessionKey,
    lifecycleGeneration: "temperature-generation",
  });
  sessionPromptState.sessionTarget = {
    agentId: "main",
    sessionId: runParams.sessionId,
    sessionKey,
    storePath: params.storePath ?? "/temperature-test-store.json",
  };
  const model: DispatchInput["preparedRuntime"]["model"] = {
    id: "temperature-model",
    name: "Temperature fixture",
    provider: "fixture",
    api: "openai-completions",
    baseUrl: "https://model.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 2_048,
  };
  const authStorage = AuthStorage.inMemory();
  const authProfileStore: DispatchInput["preparedRuntime"]["attemptAuthProfileStore"] = {
    version: 1,
    profiles: {},
  };
  const unexpectedRuntimeWork = (): never => {
    throw new Error("temperature preparation must not execute downstream runtime work");
  };
  // Real state/controller constructors and in-memory stores keep this input
  // type checked while session reads and downstream model dispatch stay isolated.
  const input: DispatchInput = {
    provider: "fixture",
    modelId: "temperature-model",
    startupStagesEmitted: true,
    runInput: {
      runParams,
      provider: "fixture",
      modelId: model.id,
      workspaceResolution: {
        agentId: "main",
        agentIdSource: "explicit",
        workspaceDir,
        isCanonicalWorkspace: true,
        usedFallback: false,
      },
      isCanonicalWorkspace: true,
      globalLane: "main",
      hookRunner: null,
      hookContext: { sessionId: runParams.sessionId, workspaceDir },
      fallbackConfigured: false,
      isProbeSession: false,
      resolvedToolResultFormat: "markdown",
      startedAtMs: 0,
      startupStages: createEmbeddedRunStageTracker(),
      emitStartupStageSummary: () => undefined,
      lifecycleGeneration: "temperature-generation",
      suspendForFailure: () => undefined,
      workspaceDir,
      agentDir: workspaceDir,
      resolvedSessionKey: sessionKey,
      progressController: createEmbeddedRunProgressController({
        attempt: runParams,
        noteLaneTaskProgress: () => undefined,
        startedAtMs: 0,
      }),
      laneController: {
        enqueueGlobal: async () => unexpectedRuntimeWork(),
        enqueueSession: async () => unexpectedRuntimeWork(),
        laneTaskAbortController: new AbortController(),
        laneTaskReleaseController: new AbortController(),
        noteLaneTaskProgress: () => undefined,
        throwIfAborted: () => undefined,
      },
    },
    preparedRuntime: {
      admittedRunContext: {
        operationalRunInstance: { instanceId: "temperature-instance", runId: runParams.runId },
      },
      provider: "fixture",
      modelId: model.id,
      requestedModelId: model.id,
      expectedHarnessArtifact: undefined,
      nativeModelOwned: false,
      model,
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      attemptAuthProfileStore: authProfileStore,
      profileFailureStore: authProfileStore,
      lockedProfileId: undefined,
      preferredProfileId: undefined,
      profileCandidates: [],
      genericCompactionRecoveryAllowed: true,
      pluginHarnessOwnsAuthBootstrap: false,
      attemptedThinking: new Set(),
      advanceAttemptAuthProfile: async () => unexpectedRuntimeWork(),
      maybeRefreshRuntimeAuthForAuthError: async () => unexpectedRuntimeWork(),
      stopRuntimeAuthRefreshTimer: () => undefined,
      getApiKeyInfo: () => null,
      setThinkLevel: () => undefined,
      snapshot: () => ({
        effectiveModel: model,
        agentHarness: {
          id: "openclaw",
          label: "Temperature fixture",
          supports: unexpectedRuntimeWork,
          runAttempt: async () => unexpectedRuntimeWork(),
        },
        contextTokenBudget: 32_000,
        authoredContextTokenCap: undefined,
        contextWindowInfo: { tokens: 32_000, source: "model" },
        outerContextTokenMeta: { contextTokens: 32_000 },
        activePreparedAuthPlan: {
          providerForAuth: "fixture",
          authProfileProviderForAuth: "fixture",
        },
        lastProfileId: undefined,
        pluginMetadataSnapshot: undefined,
        providerRuntimeHandle: { provider: "fixture", modelId: model.id, prepared: true },
        thinkLevel: "off",
        apiKeyInfo: null,
        runtimeAuthState: null,
        pluginHarnessOwnsTransport: false,
      }),
      resolveRunAttemptAuthProfileStore: () => authProfileStore,
    },
    sessionPromptState,
    terminalRetryState: createEmbeddedRunTerminalRetryState(),
    contextEngine: {
      info: { id: "temperature-fixture", name: "Temperature fixture" },
      ingest: async () => {
        throw new Error("dispatch fixture must not ingest context");
      },
      assemble: async () => {
        throw new Error("dispatch fixture must not assemble context");
      },
      compact: async () => {
        throw new Error("dispatch fixture must not compact context");
      },
    },
    replayState: { replayInvalid: false, hadPotentialSideEffects: false },
    bootstrapPromptWarningSignaturesSeen: [],
    resolveRuntimeFallbackReason: () => null,
    observeToolOutcome: () => undefined,
    isTurnTainted: () => false,
    allocateToolOutcomeOrdinal: () => 0,
    getPostCompactionAbortError: () => undefined,
    setPostCompactionAbortController: () => undefined,
    clearPostCompactionAbortController: () => undefined,
  };
  const result = await prepareAndDispatchEmbeddedRunAttempt(input);
  expect(buildAgentRuntimePlan).toHaveBeenCalledTimes(1);
  expect(dispatchEmbeddedRunAttempt).toHaveBeenCalledTimes(1);
  expect(vi.mocked(dispatchEmbeddedRunAttempt).mock.calls[0]?.[0].runtime.runtimePlan).toBe(
    result.runtimePlan,
  );
  expect(result.dispatchedAttempt).toEqual({ kind: "dispatched" });
  return vi.mocked(buildAgentRuntimePlan).mock.calls[0]?.[0].extraParamsOverride;
}

describe("prepareAndDispatchEmbeddedRunAttempt session temperature", () => {
  it.each([0, 0.7])(
    "dispatches session temperature %s ahead of configured sampling",
    async (temperature) => {
      mockedLoad.mockReturnValue({ sessionId: "temperature-session", updatedAt: 1, temperature });
      expect(await dispatch()).toEqual({ temperature, topP: 0.9, fastMode: false });
      expect(mockedLoad).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: "agent:main:dm:1",
        storePath: "/temperature-test-store.json",
      });
    },
  );

  it("keeps configured sampling when the session has no temperature", async () => {
    mockedLoad.mockReturnValue({
      sessionId: "temperature-session",
      updatedAt: 1,
      thinkingLevel: "low",
    });
    expect(await dispatch()).toEqual({ temperature: 0.3, topP: 0.9, fastMode: false });
  });

  it("keeps configured sampling when the session entry is missing", async () => {
    mockedLoad.mockReturnValue(undefined);
    expect(await dispatch()).toEqual({ temperature: 0.3, topP: 0.9, fastMode: false });
  });

  it("does not read session sampling for a blank session key", async () => {
    expect(await dispatch({ sessionKey: " " })).toEqual({
      temperature: 0.3,
      topP: 0.9,
      fastMode: false,
    });
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("still dispatches configured sampling when the store read throws", async () => {
    mockedLoad.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    expect(await dispatch()).toEqual({ temperature: 0.3, topP: 0.9, fastMode: false });
  });

  it("reads the explicit configured session store", async () => {
    mockedLoad.mockReturnValue({
      sessionId: "temperature-session",
      updatedAt: 1,
      temperature: 1.2,
    });
    expect(await dispatch({ storePath: "/custom/store.json" })).toEqual({
      temperature: 1.2,
      topP: 0.9,
      fastMode: false,
    });
    expect(mockedLoad).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:dm:1",
      storePath: "/custom/store.json",
    });
  });
});
