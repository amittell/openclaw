import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveFreshSessionTotalTokens } from "../../../config/sessions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../../config/sessions/types.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { NormalizedUsage } from "../../usage.js";
import {
  persistSettledAttemptContextTotalTokens,
  resolvePerAttemptContextTotalTokens,
} from "./attempt-finalize.js";

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

describe("resolvePerAttemptContextTotalTokens", () => {
  it("returns undefined without usage or when all components are zero", () => {
    expect(resolvePerAttemptContextTotalTokens(undefined)).toBeUndefined();
    expect(resolvePerAttemptContextTotalTokens(usage({}))).toBeUndefined();
    expect(
      resolvePerAttemptContextTotalTokens(
        usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      ),
    ).toBeUndefined();
  });

  it("prefers a usable provider contextUsage snapshot (turn-completion semantics)", () => {
    const candidate = resolvePerAttemptContextTotalTokens(
      usage({
        input: 1_000,
        output: 200,
        contextUsage: { state: "available", promptTokens: 42_000, totalTokens: 43_000 },
      }),
    );
    expect(candidate).toBe(42_000);
  });

  it("sums usage components when no contextUsage snapshot is reported", () => {
    const candidate = resolvePerAttemptContextTotalTokens(
      usage({ input: 10_000, cacheRead: 30_000, cacheWrite: 500, output: 800 }),
    );
    expect(candidate).toBe(41_300);
  });

  it("takes the greater of the reported call total and the component sum", () => {
    expect(resolvePerAttemptContextTotalTokens(usage({ input: 10, output: 20, total: 999 }))).toBe(
      999,
    );
    expect(resolvePerAttemptContextTotalTokens(usage({ input: 50, output: 60, total: 10 }))).toBe(
      110,
    );
  });

  it("does not block on a contextUsage marked unavailable", () => {
    const candidate = resolvePerAttemptContextTotalTokens(
      usage({ input: 12_000, output: 100, contextUsage: { state: "unavailable" } }),
    );
    expect(candidate).toBe(12_100);
  });
});

describe("persistSettledAttemptContextTotalTokens", () => {
  const attempt = (scope: Scope) => ({
    sessionTarget: {
      agentId: scope.agentId,
      sessionId: undefined,
      sessionKey: scope.sessionKey,
      storePath: scope.storePath,
    },
    sessionPersistence: "durable" as const,
  });

  it("advances the entry totalTokens after a mid-turn tool-call settle without contextUsage", async () => {
    await withStore(async (fixture) => {
      await persistSettledAttemptContextTotalTokens({
        attempt: attempt(fixture.scope),
        sessionIdUsed: fixture.entry.sessionId,
        lastCallUsage: usage({ input: 20_000, cacheRead: 15_000, output: 700 }),
        compactionOccurredThisAttempt: false,
      });
      const row = fixture.read();
      expect(row?.totalTokens).toBe(35_700);
      expect(row?.totalTokensFresh).toBe(true);
      expect(resolveFreshSessionTotalTokens(row)).toBe(35_700);
    });
  });

  it("keeps advancing as later attempts report higher usage", async () => {
    await withStore(async (fixture) => {
      for (const input of [30_000, 90_000, 45_000]) {
        await persistSettledAttemptContextTotalTokens({
          attempt: attempt(fixture.scope),
          sessionIdUsed: fixture.entry.sessionId,
          lastCallUsage: usage({ input, output: 100 }),
          compactionOccurredThisAttempt: false,
        });
      }
      const row = fixture.read();
      expect(row?.totalTokens).toBe(90_100);
      expect(resolveFreshSessionTotalTokens(row)).toBe(90_100);
    });
  });

  it("does not stamp a session that rotated while the attempt ran", async () => {
    await withStore(async (fixture) => {
      // /new or a reset replaces the row with a fresh generation mid-run.
      const rotated: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 2,
        compactionCount: 0,
      };
      await replaceSessionEntry(fixture.scope, rotated);
      await persistSettledAttemptContextTotalTokens({
        attempt: attempt(fixture.scope),
        sessionIdUsed: fixture.entry.sessionId,
        lastCallUsage: usage({ input: 80_000, output: 500 }),
        compactionOccurredThisAttempt: false,
      });
      const row = fixture.read();
      expect(row?.sessionId).toBe(rotated.sessionId);
      expect(row?.totalTokens).toBeUndefined();
      expect(resolveFreshSessionTotalTokens(row)).toBeUndefined();
    });
  });

  it("rejects the write when the admission lifecycle revision or writer claim moved", async () => {
    await withStore(async (fixture) => {
      await replaceSessionEntry(fixture.scope, {
        ...fixture.entry,
        activeWriterRunId: "run-later",
      });
      const fenced = (expectedLifecycleRevision: string, expectedWriterRunId: string) => ({
        ...attempt(fixture.scope),
        sessionTarget: {
          ...attempt(fixture.scope).sessionTarget,
          expectedLifecycleRevision,
          expectedWriterRunId,
        },
      });
      for (const target of [
        fenced(randomUUID(), "run-later"),
        fenced(fixture.entry.lifecycleRevision ?? "", "run-earlier"),
      ]) {
        await persistSettledAttemptContextTotalTokens({
          attempt: target,
          sessionIdUsed: fixture.entry.sessionId,
          lastCallUsage: usage({ input: 50_000, output: 100 }),
          compactionOccurredThisAttempt: false,
        });
      }
      expect(fixture.read()?.totalTokens).toBe(0);
      await persistSettledAttemptContextTotalTokens({
        attempt: fenced(fixture.entry.lifecycleRevision ?? "", "run-later"),
        sessionIdUsed: fixture.entry.sessionId,
        lastCallUsage: usage({ input: 50_000, output: 100 }),
        compactionOccurredThisAttempt: false,
      });
      expect(fixture.read()?.totalTokens).toBe(50_100);
    });
  });

  it("is a no-op for detached runs and when compaction occurred during the attempt", async () => {
    await withStore(async (fixture) => {
      await persistSettledAttemptContextTotalTokens({
        attempt: { ...attempt(fixture.scope), sessionPersistence: "detached" },
        sessionIdUsed: fixture.entry.sessionId,
        lastCallUsage: usage({ input: 10, output: 20 }),
        compactionOccurredThisAttempt: false,
      });
      await persistSettledAttemptContextTotalTokens({
        attempt: attempt(fixture.scope),
        sessionIdUsed: fixture.entry.sessionId,
        lastCallUsage: usage({ input: 10, output: 20 }),
        compactionOccurredThisAttempt: true,
      });
      const row = fixture.read();
      expect(row?.totalTokens).toBe(0);
    });
  });
});
