// Verifies that a run served by a model fallback does not rewrite the session's
// persisted model, provider or context budget.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  seedSessionStore,
  updateSessionStoreAfterAgentRun,
  withTempSessionStore,
} from "./session-store.test-support.js";

// mock-isolation: Classify CLI providers from a fixed list instead of the plugin CLI-backend registry.
vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

describe("updateSessionStoreAfterAgentRun", () => {
  it("does not persist fallback model/provider/contextTokens when isFromFallback is true", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-fallback-no-persist-explicit";
      const sessionId = "test-fallback-no-persist-explicit-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          model: "gpt-5.4",
          modelProvider: "openai",
          contextTokens: 256_000,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        fallbackProvider: "anthropic",
        fallbackModel: "claude-sonnet-4-20250514",
        isFromFallback: true,
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
              contextTokens: 200_000,
              usage: { input: 100, output: 50 },
            },
          },
        },
      });

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(persisted?.model).toBe("gpt-5.4");
      expect(persisted?.modelProvider).toBe("openai");
      expect(persisted?.contextTokens).toBe(256_000);
    });
  });

  it("does not persist fallback model/provider/contextTokens when fallback is auto-detected", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-fallback-no-persist-auto";
      const sessionId = "test-fallback-no-persist-auto-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
          model: "gpt-5.4",
          modelProvider: "openai",
          contextTokens: 256_000,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        fallbackProvider: "anthropic",
        fallbackModel: "claude-sonnet-4-20250514",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "anthropic",
              model: "claude-sonnet-4-20250514",
              contextTokens: 200_000,
              usage: { input: 100, output: 50 },
            },
          },
        },
      });

      const persisted = loadSessionEntry({ storePath, sessionKey });
      expect(persisted?.model).toBe("gpt-5.4");
      expect(persisted?.modelProvider).toBe("openai");
      expect(persisted?.contextTokens).toBe(256_000);
    });
  });
});
