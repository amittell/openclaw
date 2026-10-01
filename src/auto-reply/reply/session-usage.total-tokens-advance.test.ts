import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFreshSessionTotalTokens } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionTotalTokensAdvance } from "./session-usage.js";

type Scope = {
  agentId: string;
  storePath: string;
  sessionKey: string;
};

async function withAdvanceFixture(
  body: (fixture: {
    scope: Scope;
    entry: InternalSessionEntry;
    sessionStore: Record<string, InternalSessionEntry>;
    read: () => InternalSessionEntry | undefined;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "total-tokens-advance", scenario: "minimal" },
    async (state) => {
      const scope: Scope = {
        agentId: "main",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        sessionKey: "agent:main:total-tokens-advance",
      };
      const entry: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        compactionCount: 0,
        // Bootstrap stamp: totalTokens starts as a known zero, not unknown.
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      };
      await replaceSessionEntry(scope, entry);
      const sessionStore: Record<string, InternalSessionEntry> = {
        [scope.sessionKey]: entry,
      };
      await body({
        scope,
        entry,
        sessionStore,
        read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
      });
    },
  );
}

describe("persistSessionTotalTokensAdvance", () => {
  it("advances the entry totalTokens from a positive settled usage without contextUsage", async () => {
    await withAdvanceFixture(async (fixture) => {
      const fence = fixture.entry;
      await persistSessionTotalTokensAdvance({
        agentId: fixture.scope.agentId,
        storePath: fixture.scope.storePath,
        sessionKey: fixture.scope.sessionKey,
        expectedSession: {
          sessionId: fence.sessionId,
          lifecycleRevision: fence.lifecycleRevision,
          compactionCount: fence.compactionCount,
        },
        totalTokens: 1234,
      });
      const row = fixture.read();
      expect(row?.totalTokens).toBe(1234);
      expect(row?.totalTokensFresh).toBe(true);
      expect(row?.totalTokensVersion).toBe(SESSION_TOTAL_TOKENS_VERSION);
      expect(resolveFreshSessionTotalTokens(row)).toBe(1234);
    });
  });

  it("is advance-only: higher usage advances further, lower usage is ignored", async () => {
    await withAdvanceFixture(async (fixture) => {
      const fence = fixture.entry;
      const expectedSession = {
        sessionId: fence.sessionId,
        lifecycleRevision: fence.lifecycleRevision,
        compactionCount: fence.compactionCount,
      };
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession,
        totalTokens: 5000,
      });
      expect(fixture.read()?.totalTokens).toBe(5000);
      // Equal candidate is not an advance.
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession,
        totalTokens: 5000,
      });
      expect(fixture.read()?.totalTokens).toBe(5000);
      // Lower candidate must be ignored (no shrink).
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession,
        totalTokens: 1200,
      });
      const row = fixture.read();
      expect(row?.totalTokens).toBe(5000);
      expect(resolveFreshSessionTotalTokens(row)).toBe(5000);
    });
  });

  it("lowers only the writer's own earlier value and reports whether it applied", async () => {
    await withAdvanceFixture(async (fixture) => {
      const expectedSession = { sessionId: fixture.entry.sessionId };
      await expect(
        persistSessionTotalTokensAdvance({ ...fixture.scope, expectedSession, totalTokens: 9000 }),
      ).resolves.toBe(true);
      // Another writer's value (say, 9000 from turn accounting) never moves down.
      await expect(
        persistSessionTotalTokensAdvance({
          ...fixture.scope,
          expectedSession,
          totalTokens: 3000,
          replaceOwnValue: 7000,
        }),
      ).resolves.toBe(false);
      expect(fixture.read()?.totalTokens).toBe(9000);
      // The writer's own publish follows the context down, e.g. after compaction.
      await expect(
        persistSessionTotalTokensAdvance({
          ...fixture.scope,
          expectedSession,
          totalTokens: 3000,
          replaceOwnValue: 9000,
        }),
      ).resolves.toBe(true);
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(3000);
    });
  });

  it("rejects non-positive and non-finite candidates without touching the entry", async () => {
    await withAdvanceFixture(async (fixture) => {
      const before = fixture.read();
      for (const totalTokens of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await persistSessionTotalTokensAdvance({
          ...fixture.scope,
          expectedSession: { sessionId: fixture.entry.sessionId },
          totalTokens,
        });
      }
      const after = fixture.read();
      expect(after?.totalTokens).toBe(before?.totalTokens);
      expect(after?.totalTokensFresh).toBe(before?.totalTokensFresh);
    });
  });

  it("is fenced by session rotation: a stale sessionId expectation writes nothing", async () => {
    await withAdvanceFixture(async (fixture) => {
      // Simulate a session identity rewrite (rotation) that replaces the row.
      const rotated: InternalSessionEntry = {
        ...fixture.entry,
        sessionId: randomUUID(),
        updatedAt: 2,
      };
      await replaceSessionEntry(fixture.scope, rotated);
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession: {
          sessionId: fixture.entry.sessionId,
          lifecycleRevision: fixture.entry.lifecycleRevision,
          compactionCount: 0,
        },
        totalTokens: 99999,
      });
      const row = fixture.read();
      expect(row?.sessionId).toBe(rotated.sessionId);
      expect(row?.totalTokens).toBe(0);
    });
  });

  it("is fenced by compaction: a stale pre-compaction write does not resurrect the cleared value", async () => {
    await withAdvanceFixture(async (fixture) => {
      // Mid-turn advance lands a fresh high value.
      const preCompactionFence = fixture.entry;
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession: {
          sessionId: preCompactionFence.sessionId,
          lifecycleRevision: preCompactionFence.lifecycleRevision,
          compactionCount: preCompactionFence.compactionCount,
        },
        totalTokens: 95_000,
      });
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(95_000);

      // The compaction accounting commit: same session identity, compactionCount
      // stamped atomically with the totalTokens invalidation.
      const persistedCount = await incrementCompactionCount({
        ...fixture.scope,
        sessionStore: fixture.sessionStore,
        expectedSession: preCompactionFence,
        compactionKind: "native-harness",
      });
      expect(persistedCount).toBe(1);
      const compacted = fixture.read();
      expect(compacted?.compactionCount).toBe(1);
      expect(resolveFreshSessionTotalTokens(compacted)).toBeUndefined();

      // A per-attempt write prepared before the compaction commit is now stale:
      // its captured fence still carries compactionCount 0, so it must not
      // publish the pre-compaction context snapshot.
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession: {
          sessionId: preCompactionFence.sessionId,
          lifecycleRevision: preCompactionFence.lifecycleRevision,
          compactionCount: preCompactionFence.compactionCount,
        },
        totalTokens: 95_000,
      });
      const after = fixture.read();
      expect(after?.totalTokensFresh).not.toBe(true);
      expect(resolveFreshSessionTotalTokens(after)).toBeUndefined();

      // A fresh post-compaction observation is still accepted.
      const postFence = fixture.read() as InternalSessionEntry;
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession: {
          sessionId: postFence.sessionId,
          lifecycleRevision: postFence.lifecycleRevision,
          compactionCount: postFence.compactionCount,
        },
        totalTokens: 40_000,
      });
      const refreshed = fixture.read();
      expect(resolveFreshSessionTotalTokens(refreshed)).toBe(40_000);
    });
  });

  it("accepts the first fresh value on a non-fresh (stale/compacted) entry", async () => {
    await withAdvanceFixture(async (fixture) => {
      // Entry currently reads as unknown (fresh=false), e.g. post-compaction.
      const staleRow = {
        ...fixture.read(),
        totalTokens: 88_000,
        totalTokensFresh: false,
        totalTokensVersion: undefined,
      };
      await replaceSessionEntry(fixture.scope, {
        ...staleRow,
        updatedAt: 3,
      } as InternalSessionEntry);
      const fence = fixture.read() as InternalSessionEntry;
      await persistSessionTotalTokensAdvance({
        ...fixture.scope,
        expectedSession: {
          sessionId: fence.sessionId,
          lifecycleRevision: fence.lifecycleRevision,
          compactionCount: fence.compactionCount,
        },
        totalTokens: 100,
      });
      const row = fixture.read();
      // Unknown current value is not a monotonicity baseline: the first fresh
      // observation publishes even when smaller than the stale number.
      expect(row?.totalTokens).toBe(100);
      expect(resolveFreshSessionTotalTokens(row)).toBe(100);
    });
  });
});
