import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveFreshSessionTotalTokens } from "../../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../../config/sessions/types.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { NormalizedUsage } from "../../usage.js";
import { createContextTotalTokensAdvance } from "./attempt-context-total-tokens.js";

type Scope = {
  agentId: string;
  storePath: string;
  sessionKey: string;
};

async function withStore(
  body: (fixture: {
    scope: Scope;
    entry: InternalSessionEntry;
    read: () => InternalSessionEntry | undefined;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "attempt-context-advance", scenario: "minimal" },
    async (state) => {
      const scope: Scope = {
        agentId: "main",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        sessionKey: "agent:main:attempt-context-advance",
      };
      const entry: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        activeWriterRunId: "run-1",
        updatedAt: 1,
        compactionCount: 0,
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      };
      await replaceSessionEntry(scope, entry);
      await body({
        scope,
        entry,
        read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
      });
    },
  );
}

const usage = (partial: NormalizedUsage): NormalizedUsage => ({
  input: 0,
  output: 0,
  ...partial,
});

const attemptFor = (
  scope: Scope,
  entry: InternalSessionEntry,
  overrides: { lifecycleRevision?: string; writerRunId?: string } = {},
) => ({
  sessionId: entry.sessionId,
  sessionTarget: {
    agentId: scope.agentId,
    sessionId: entry.sessionId,
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    expectedLifecycleRevision: overrides.lifecycleRevision ?? entry.lifecycleRevision,
    expectedWriterRunId: overrides.writerRunId ?? "run-1",
  },
  sessionPersistence: "durable" as const,
});

describe("createContextTotalTokensAdvance", () => {
  it("publishes each settled call while the attempt runs, coalescing to the latest", async () => {
    await withStore(async (fixture) => {
      const advance = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      advance.offer(usage({ input: 20_000, cacheRead: 15_000, output: 700 }));
      // Visible while the attempt is still running, not only once it closes.
      await vi.waitFor(() => expect(fixture.read()?.totalTokens).toBe(35_000));
      advance.offer(usage({ input: 60_000, output: 100 }));
      advance.offer(usage({ input: 80_000, output: 100 }));
      await advance.close();
      const row = fixture.read();
      expect(row?.totalTokens).toBe(80_000);
      expect(resolveFreshSessionTotalTokens(row)).toBe(80_000);
    });
  });

  it("does not stamp a session that rotated while the attempt ran", async () => {
    await withStore(async (fixture) => {
      const advance = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      // /new or a reset replaces the row with a fresh generation mid-run.
      const rotated: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 2,
        compactionCount: 0,
      };
      await replaceSessionEntry(fixture.scope, rotated);
      advance.offer(usage({ input: 80_000, output: 500 }));
      await advance.close();
      const row = fixture.read();
      expect(row?.sessionId).toBe(rotated.sessionId);
      expect(resolveFreshSessionTotalTokens(row)).toBeUndefined();
    });
  });

  it("rejects the write when the admission lifecycle revision or writer claim moved", async () => {
    await withStore(async (fixture) => {
      for (const overrides of [{ lifecycleRevision: randomUUID() }, { writerRunId: "run-0" }]) {
        const advance = createContextTotalTokensAdvance({
          attempt: attemptFor(fixture.scope, fixture.entry, overrides),
        });
        advance.offer(usage({ input: 50_000, output: 100 }));
        await advance.close();
      }
      expect(fixture.read()?.totalTokens).toBe(0);
    });
  });

  it("stores prompt tokens only and leaves an unavailable snapshot unknown", async () => {
    await withStore(async (fixture) => {
      const advance = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      advance.offer(usage({ input: 9_000, output: 100, contextUsage: { state: "unavailable" } }));
      await advance.close();
      expect(fixture.read()?.totalTokens).toBe(0);
      const next = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      next.offer(usage({ input: 10_000, cacheRead: 30_000, cacheWrite: 500, output: 800 }));
      await next.close();
      expect(fixture.read()?.totalTokens).toBe(40_500);
    });
  });

  it("abandon drops the pending offer but still waits out the write in flight", async () => {
    await withStore(async (fixture) => {
      const advance = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      advance.offer(usage({ input: 30_000, output: 100 }));
      advance.offer(usage({ input: 70_000, output: 100 }));
      await advance.abandon();
      expect(fixture.read()?.totalTokens).toBe(30_000);
    });
  });

  it("ignores offers after close and for detached runs", async () => {
    await withStore(async (fixture) => {
      const closed = createContextTotalTokensAdvance({
        attempt: attemptFor(fixture.scope, fixture.entry),
      });
      await closed.close();
      closed.offer(usage({ input: 10_000, output: 20 }));
      const detached = createContextTotalTokensAdvance({
        attempt: { ...attemptFor(fixture.scope, fixture.entry), sessionPersistence: "detached" },
      });
      detached.offer(usage({ input: 10_000, output: 20 }));
      await detached.close();
      expect(fixture.read()?.totalTokens).toBe(0);
    });
  });
});
