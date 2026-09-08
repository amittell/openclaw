// Coverage for the runtime auth refresh scheduler and its hard-deadline backstop.
//
// Split out of ./auth-controller.test.ts to keep that file within the
// max-lines budget. The shared harness lives in ./auth-controller.test-support.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { looksLikeSecretSentinel, resolveSecretSentinel } from "../../../secrets/sentinel.js";

const mocks = vi.hoisted(() => ({
  prepareProviderRuntimeAuth: vi.fn(),
  getApiKeyForModelCore: vi.fn(),
}));

vi.mock("../../../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../../plugins/provider-runtime.js")>(
    "../../../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
  };
});

vi.mock("../../model-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../model-auth.js")>("../../model-auth.js");
  return {
    ...actual,
    getApiKeyForModelCore: mocks.getApiKeyForModelCore,
  };
});

import { RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS } from "../../runtime-auth-refresh.js";
import {
  createMutableAuthControllerHarness,
  createMutableEmbeddedRunAuthController,
  expectProtectedRuntimeValue,
  getRuntimeAuthSnapshot,
} from "./auth-controller.test-support.js";
import { RUNTIME_AUTH_REFRESH_RETRY_MS } from "./helpers.js";

describe("createEmbeddedRunAuthController", () => {
  beforeEach(() => {
    mocks.prepareProviderRuntimeAuth.mockReset();
    mocks.getApiKeyForModelCore.mockReset();
  });

  it("ignores stale scheduled refresh results after auth profile rotation", async () => {
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const staleRefresh = createDeferred<{
        apiKey: string;
        baseUrl: string;
        request: {
          auth: {
            mode: "header";
            headerName: string;
            value: string;
          };
        };
        expiresAt: number;
      }>();

      mocks.getApiKeyForModelCore.mockImplementation(async ({ profileId }) => {
        if (profileId === "backup") {
          return {
            apiKey: "backup-source-api-key",
            mode: "api-key",
            profileId: "backup",
            source: "env",
          };
        }
        return {
          apiKey: "default-source-api-key",
          mode: "api-key",
          profileId: "default",
          source: "env",
        };
      });
      mocks.prepareProviderRuntimeAuth.mockImplementation(async ({ context }) => {
        if (context.apiKey === "default-source-api-key" && context.profileId === "default") {
          if (harness.runtimeAuthState?.refreshInFlight) {
            return staleRefresh.promise;
          }
          return {
            apiKey: "default-runtime-api-key",
            baseUrl: "https://default-runtime.example.com/v1",
            request: {
              auth: {
                mode: "header",
                headerName: "api-key",
                value: "default-runtime-header-token",
              },
            },
            expiresAt: Date.now() + 60_000,
          };
        }
        if (context.apiKey === "backup-source-api-key" && context.profileId === "backup") {
          return {
            apiKey: "backup-runtime-api-key",
            baseUrl: "https://backup-runtime.example.com/v1",
            request: {
              auth: {
                mode: "header",
                headerName: "api-key",
                value: "backup-runtime-header-token",
              },
            },
            expiresAt: Date.now() + 120_000,
          };
        }
        throw new Error(`Unexpected runtime auth request for ${String(context.profileId)}`);
      });

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["default", "backup"],
      });

      await controller.initializeAuthProfile();
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("default");

      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      const refreshInFlight = getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight;
      expect(typeof refreshInFlight?.then).toBe("function");

      await controller.advanceAuthProfile();
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      const backupHeader = harness.runtimeModel.headers?.["api-key"];
      expectProtectedRuntimeValue(backupHeader, "backup-runtime-header-token");

      staleRefresh.resolve({
        apiKey: "default-runtime-api-key-refreshed",
        baseUrl: "https://default-refresh.example.com/v1",
        request: {
          auth: {
            mode: "header",
            headerName: "api-key",
            value: "default-refresh-header-token",
          },
        },
        expiresAt: Date.now() + 30_000,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.profileId).toBe("backup");
      expect(harness.runtimeModel.baseUrl).toBe("https://backup-runtime.example.com/v1");
      expect(harness.runtimeModel.headers?.["api-key"]).toBe(backupHeader);
      const storedBackupApiKey = setRuntimeApiKey.mock.calls.at(-1)?.[1];
      expectProtectedRuntimeValue(storedBackupApiKey, "backup-runtime-api-key");
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the in-flight refresh handle when a refresh hangs past the hard deadline", async () => {
    // Regression for the rh-bot gateway freeze: a provider auth hook that never
    // settles left `refreshInFlight` pending forever, and every later model turn
    // deadlocked at `await refreshInFlight`. The hard deadline must force the
    // handle to settle so the single-flight cannot wedge the whole gateway.
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();

      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });

      let call = 0;
      mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          // Initial exchange resolves so a refresh gets scheduled (expiry soon).
          return {
            apiKey: "runtime-api-key",
            baseUrl: "https://runtime.example.com/v1",
            request: {
              auth: { mode: "header", headerName: "api-key", value: "runtime-token" },
            },
            expiresAt: Date.now() + 60_000,
          };
        }
        // Every scheduled refresh hangs forever — the provider auth hook wedge.
        return new Promise(() => {});
      });

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["default"],
      });

      await controller.initializeAuthProfile();

      // Fire the scheduled refresh (min delay 5s); it hangs, so the handle is set.
      await vi.advanceTimersByTimeAsync(5_000);
      const inflight = getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight;
      expect(typeof inflight?.then).toBe("function");

      // Before the fix this stayed pending forever. The hard deadline rejects it.
      const rejection = expect(inflight).rejects.toThrow(/exceeded hard deadline/);
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;
      // The wedged handle is no longer the active in-flight handle.
      expect(getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight).not.toBe(inflight);

      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a deadline-abandoned refresh completion after a successful retry", async () => {
    // Regression for the stale write-back class: the hard deadline abandons a
    // hung refresh without cancelling it. Once the retry installs fresh
    // credentials, the abandoned continuation's eventual completion must fail
    // the generation stale-check and no-op instead of overwriting them.
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      const staleRefresh = createDeferred<{ apiKey: string; expiresAt: number }>();

      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });

      let call = 0;
      mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
        call += 1;
        if (call === 1) {
          return { apiKey: "runtime-api-key", expiresAt: Date.now() + 60_000 };
        }
        if (call === 2) {
          // First scheduled refresh hangs past the hard deadline.
          return staleRefresh.promise;
        }
        return { apiKey: "retry-runtime-api-key", expiresAt: Date.now() + 60_000 };
      });

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["default"],
      });

      await controller.initializeAuthProfile();

      // Scheduled refresh (min delay 5s) hangs; the deadline abandons it.
      await vi.advanceTimersByTimeAsync(5_000);
      const inflight = getRuntimeAuthSnapshot(harness.runtimeAuthState)?.refreshInFlight;
      const rejection = expect(inflight).rejects.toThrow(/exceeded hard deadline/);
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;

      // The invariant under test is WHICH key wins (retry vs abandoned), not
      // the sink's protection level: this refresh path stores raw keys on the
      // 7.1 base while newer upstream wraps them in redaction sentinels.
      // Resolve sentinels when present so the assertion holds on both.
      const expectLastRuntimeApiKey = (plaintext: string) => {
        const lastCall = setRuntimeApiKey.mock.calls.at(-1);
        expect(lastCall?.[0]).toBe("custom-openai");
        const stored = lastCall?.[1];
        const resolved = looksLikeSecretSentinel(stored ?? "")
          ? resolveSecretSentinel(stored ?? "")
          : stored;
        expect(resolved).toBe(plaintext);
      };

      // The scheduled-retry lane recovers with fresh credentials.
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_RETRY_MS);
      expectLastRuntimeApiKey("retry-runtime-api-key");

      // The abandoned refresh finally settles with stale credentials; the
      // bumped generation must make its write-back a no-op.
      staleRefresh.resolve({ apiKey: "stale-runtime-api-key", expiresAt: Date.now() + 5_000 });
      await vi.advanceTimersByTimeAsync(0);

      expectLastRuntimeApiKey("retry-runtime-api-key");
      const staleWrites = setRuntimeApiKey.mock.calls.filter(
        ([, apiKey]) =>
          apiKey === "stale-runtime-api-key" ||
          resolveSecretSentinel(apiKey) === "stale-runtime-api-key",
      );
      expect(staleWrites).toHaveLength(0);
      controller.stopRuntimeAuthRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails over instead of hanging when cold-start auth prep exceeds the hard deadline", async () => {
    // The #93952 deadline originally covered only refreshRuntimeAuth. The
    // cold-start / profile-rotation path (initializeAuthProfile -> applyApiKeyInfo
    // -> prepareProviderRuntimeAuth) is the exact hook that hung in the rh-bot
    // incident AND the path a watchdog kickstart lands on first. It must also be
    // backstopped so a fresh boot can never re-wedge the lane.
    vi.useFakeTimers();
    try {
      const harness = createMutableAuthControllerHarness();
      const setRuntimeApiKey = vi.fn<(provider: string, apiKey: string) => void>();
      mocks.getApiKeyForModelCore.mockResolvedValue({
        apiKey: "source-api-key",
        mode: "api-key",
        profileId: "default",
        source: "env",
      });
      // The provider auth hook hangs forever on cold start.
      mocks.prepareProviderRuntimeAuth.mockImplementation(() => new Promise(() => {}));

      const controller = createMutableEmbeddedRunAuthController({
        harness,
        setRuntimeApiKey,
        profileCandidates: ["default"],
      });

      const init = controller.initializeAuthProfile();
      const rejection = expect(init).rejects.toBeTruthy();
      await vi.advanceTimersByTimeAsync(RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
