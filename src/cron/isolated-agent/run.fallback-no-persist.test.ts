import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runWithModelFallbackMock,
  setSessionRuntimeModelMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fallback model not persisted", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("persists hook-overridden model even though it differs from configured default", async () => {
    setSessionRuntimeModelMock.mockImplementation((entry, selection) => {
      entry.model = selection.model;
      entry.modelProvider = selection.provider;
    });
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "hook-routed response" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-opus-4-5",
            isHookOverride: true,
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "openai",
      model: "gpt-4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.model).toBe("claude-opus-4-5");
    expect(cronSession.sessionEntry.modelProvider).toBe("anthropic");
  });

  it("does not overwrite session model/provider when a fallback was used", async () => {
    setSessionRuntimeModelMock.mockImplementation((entry, selection) => {
      entry.model = selection.model;
      entry.modelProvider = selection.provider;
    });
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "fallback response" }],
        meta: {
          agentMeta: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.model).toBe("gpt-4");
    expect(cronSession.sessionEntry.modelProvider).toBe("openai");
  });

  it("does not persist fallback CLI session ID when a fallback was used", async () => {
    isCliProviderMock.mockReturnValue(true);
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-4",
        modelProvider: "openai",
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "fallback response" }],
        meta: {
          agentMeta: {
            provider: "claude-cli",
            model: "claude-opus-4-5",
            sessionId: "fallback-cli-session-xyz",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "claude-cli",
      model: "claude-opus-4-5",
      attempts: [],
    });

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob(),
      }),
    );

    const entryStr = JSON.stringify(cronSession.sessionEntry);
    expect(entryStr).not.toContain("fallback-cli-session-xyz");
  });
});
