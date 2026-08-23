import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { handleEmbeddedAssistantFailure } from "./run/assistant-failure.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./run/terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

type FailureInput = Parameters<typeof handleEmbeddedAssistantFailure>[0];

function makeAssistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    content: [],
    usage: {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 1,
    ...overrides,
  };
}

function makeInput(
  options: {
    assistant?: AssistantMessage;
    attempt?: Partial<EmbeddedRunAttemptResult>;
    emptyErrorRetries?: number;
  } = {},
): FailureInput {
  const assistant = options.assistant ?? makeAssistant();
  const attempt = makeAttemptResult({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...options.attempt,
  });
  return {
    runParams: {
      sessionId: "session:empty-error",
      sessionKey: "agent:main:empty-error",
      runId: "run:empty-error",
      config: undefined,
    } as FailureInput["runParams"],
    attempt,
    attemptAssistant: assistant,
    currentAttemptAssistant: assistant,
    terminalState: resolveEmbeddedRunAttemptTerminalState({ attempt, assistant }),
    activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
    provider: "openai",
    providerOwner: undefined,
    modelId: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    thinkLevel: "off",
    getThinkLevel: () => "off",
    attemptedThinking: new Set(["off"]),
    fallbackConfigured: false,
    pluginHarnessOwnsTransport: false,
    canRestartForLiveSwitch: false,
    authProfileStore: { version: 1, profiles: {} },
    runtimeAuthRetry: false,
    maybeRefreshRuntimeAuthForAuthError: vi.fn(async () => false),
    resolveAuthProfileFailureReason: () => null,
    emptyErrorRetries: options.emptyErrorRetries ?? 0,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 1,
    sameModelIdleTimeoutRetries: 0,
    previousRetryFailoverReason: null,
    maybeMarkAuthProfileFailure: vi.fn(async () => {}),
    maybeRetrySameModelRateLimit: vi.fn(async () => false),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => {}),
    advanceAuthProfile: vi.fn(async () => false),
    advanceRateLimitAuthProfile: vi.fn(async () => false),
    traceAttempts: [],
    suspendForFailure: vi.fn(),
    suspensionSessionId: "session:empty-error",
    agentDir: "/tmp/openclaw-empty-error-test",
    isProbeSession: false,
  };
}

describe("silent assistant-error retry owner", () => {
  it("retries a zero-output error before generic failover handling", async () => {
    const outcome = await handleEmbeddedAssistantFailure(makeInput());

    expect(outcome).toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
      preserveSameModelRateLimitRetryCount: true,
    });
  });

  it("retries reasoning-only errors without treating hidden output as a reply", async () => {
    const assistant = makeAssistant({
      content: [{ type: "thinking", thinking: "internal" }],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 120,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    expect(await handleEmbeddedAssistantFailure(makeInput({ assistant }))).toMatchObject({
      action: "retry",
      emptyErrorRetries: 1,
    });
  });

  it("does not retry an error attempt after replay-unsafe tool activity", async () => {
    const outcome = await handleEmbeddedAssistantFailure(
      makeInput({
        attempt: {
          toolMetas: [{ toolName: "write", replaySafe: false }],
        },
      }),
    );

    expect(outcome.action).toBe("proceed");
  });

  it("terminates with a visible error payload after the three-retry cap on a single-profile model", async () => {
    // Blocker: a wedged self-hosted single-profile model that fails with an
    // unclassifiable error must NOT re-dispatch whole attempts until the ingress
    // 5-min adoption-stall watchdog. After MAX_EMPTY_ERROR_RETRIES the same-model
    // silent-error path hard-stops (action "silent-error-exhausted") so the turn
    // ends in a visible outcome (the run loop converts it to a user-visible error
    // payload). fallbackConfigured defaults to false in makeInput.
    const outcome = await handleEmbeddedAssistantFailure(makeInput({ emptyErrorRetries: 3 }));

    expect(outcome.action).toBe("silent-error-exhausted");
    expect(outcome.emptyErrorRetries).toBe(3);
  });
});
