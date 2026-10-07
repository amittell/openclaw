// Regression coverage for the overload pre-failover backoff ceiling: the
// exponential policy must default to a 30s cap (not the legacy 1.5s or no
// backoff), honor the config override, and stay disabled at maxMs=0.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => {}),
  log: { warn: vi.fn() },
}));

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});
vi.mock("../logger.js", () => ({ log: mocks.log }));

import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
import { resolveOverloadFailoverBackoffPolicy } from "./helpers.js";

type ControllerInput = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];

function createController(cfg: ControllerInput["runParams"]["config"]) {
  return createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "run:overload-backoff-test",
      config: cfg,
    } as ControllerInput["runParams"],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    globalLane: "test",
    agentDir: "/tmp/openclaw-overload-backoff-test",
    fallbackConfigured: false,
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => "openai:p1",
    getSessionId: () => "session:overload-backoff-test",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile: vi.fn(async () => false),
  });
}

describe("resolveOverloadFailoverBackoffPolicy", () => {
  it("defaults to a 30s ceiling with exponential shape", () => {
    expect(resolveOverloadFailoverBackoffPolicy(undefined)).toEqual({
      initialMs: 250,
      maxMs: 30_000,
      factor: 2,
      jitter: 0.2,
    });
    expect(resolveOverloadFailoverBackoffPolicy({} as never)).toEqual({
      initialMs: 250,
      maxMs: 30_000,
      factor: 2,
      jitter: 0.2,
    });
  });

  it("honors a lower config override and a 0 disable", () => {
    expect(
      resolveOverloadFailoverBackoffPolicy({
        agents: { defaults: { embeddedAgent: { overloadBackoffMaxMs: 500 } } },
      } as never),
    ).toEqual({ initialMs: 250, maxMs: 500, factor: 2, jitter: 0.2 });
    expect(
      resolveOverloadFailoverBackoffPolicy({
        agents: { defaults: { embeddedAgent: { overloadBackoffMaxMs: 0 } } },
      } as never),
    ).toEqual({ initialMs: 250, maxMs: 0, factor: 2, jitter: 0.2 });
  });

  it("ignores invalid overrides and falls back to the 30s default", () => {
    for (const invalid of [undefined, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        resolveOverloadFailoverBackoffPolicy({
          agents: {
            defaults: {
              embeddedAgent: invalid === undefined ? {} : { overloadBackoffMaxMs: invalid },
            },
          },
        } as never),
      ).toEqual({ initialMs: 250, maxMs: 30_000, factor: 2, jitter: 0.2 });
    }
  });
});

describe("overload pre-failover backoff", () => {
  beforeEach(() => {
    mocks.sleepWithAbort.mockClear();
    mocks.log.warn.mockClear();
  });

  it("escalates the overload backoff per attempt up to the ceiling", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const controller = createController(undefined);
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      expect(mocks.sleepWithAbort.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
      await controller.maybeBackoffBeforeOverloadFailover("rate_limit");
      expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(3);
      expect(mocks.log.warn).toHaveBeenCalledWith(
        "overload backoff before failover for openai/gpt-5.6-luna: attempt=3 delayMs=1000",
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("clamps at the configured ceiling", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const controller = createController({
        agents: { defaults: { embeddedAgent: { overloadBackoffMaxMs: 500 } } },
      } as never);
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      await controller.maybeBackoffBeforeOverloadFailover("overloaded");
      // attempt 3 base = 1000 (capped to 500) + jitter <= 500
      expect(mocks.sleepWithAbort).toHaveBeenNthCalledWith(3, 500, undefined);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("stays disabled when the override is 0", async () => {
    const controller = createController({
      agents: { defaults: { embeddedAgent: { overloadBackoffMaxMs: 0 } } },
    } as never);
    await controller.maybeBackoffBeforeOverloadFailover("overloaded");
    expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
  });
});
