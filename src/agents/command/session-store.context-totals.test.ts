// Covers the command finalizer against per-call context totals published while its run was active.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveFreshSessionTotalTokens,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import {
  loadPersistedSessionEntry,
  seedSessionStore,
  updateSessionStoreAfterAgentRun,
  withTempSessionStore,
} from "./session-store.test-support.js";

describe("updateSessionStoreAfterAgentRun context totals", () => {
  it.each([
    {
      name: "the finished run's total",
      initial: {
        totalTokens: 900,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      lastCallUsage: { input: 120_000, output: 50, total: 120_050 },
      expected: 120_000,
    },
    {
      name: "unknown when the final call has no context snapshot",
      initial: {},
      lastCallUsage: { input: 9_000, output: 5, contextUsage: { state: "unavailable" as const } },
      expected: undefined,
    },
  ])(
    "replaces per-call totals published during the run with $name",
    async ({ initial, lastCallUsage, expected }) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:explicit:test-per-call-totals";
        const sessionId = "test-per-call-totals-session";
        const entry: SessionEntry = { sessionId, updatedAt: 1, ...initial };
        const sessionStore = { [sessionKey]: entry };
        // A per-call publication changes the row under this run's snapshot.
        await seedSessionStore(storePath, {
          [sessionKey]: {
            ...entry,
            totalTokens: 185_000,
            totalTokensFresh: true,
            totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
            updatedAt: 2,
          },
        });

        await updateSessionStoreAfterAgentRun({
          cfg: {} as OpenClawConfig,
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          result: {
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId,
                provider: "openai",
                model: "gpt-5.5",
                usage: { input: 300_000, output: 900, total: 300_900 },
                lastCallUsage,
              },
            },
          } as EmbeddedAgentRunResult,
        });

        expect(
          resolveFreshSessionTotalTokens(loadPersistedSessionEntry(storePath, sessionKey)),
        ).toBe(expected);
      });
    },
  );
});
