import { describe, expect, it } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — fallback model not persisted", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("does not overwrite session model/provider/contextTokens when a fallback was used", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-5.4",
        modelProvider: "openai",
        contextTokens: 256_000,
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // Simulate fallback: runWithModelFallback resolves with a different
    // provider/model than the configured primary (openai/gpt-5.4).
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
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture(),
      }),
    );

    expect(result.status).toBe("ok");

    // contextTokens belongs to the runtime-model snapshot: when the run was a
    // fallback we must preserve the existing entry value so status %used and
    // compaction heuristics do not desync from the unchanged primary model.
    expect(cronSession.sessionEntry.model).toBe("gpt-5.4");
    expect(cronSession.sessionEntry.modelProvider).toBe("openai");
    expect(cronSession.sessionEntry.contextTokens).toBe(256_000);
  });

  it("calls setSessionRuntimeModel and updates contextTokens when primary model succeeds", async () => {
    const cronSession = makeCronSession({
      sessionEntry: {
        sessionId: "test-session-id",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        model: "gpt-5.4",
        modelProvider: "openai",
        contextTokens: 256_000,
      },
    });
    resolveCronSessionMock.mockReturnValue(cronSession);

    // Primary model succeeds — runWithModelFallback returns same provider/model
    // as the configured default.
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "primary response" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
            usage: { input: 100, output: 50 },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      attempts: [],
    });

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture(),
      }),
    );

    expect(result.status).toBe("ok");

    expect(cronSession.sessionEntry.model).toBe("gpt-5.4");
    expect(cronSession.sessionEntry.modelProvider).toBe("openai");
    expect(typeof cronSession.sessionEntry.contextTokens).toBe("number");
  });
});
