import path from "node:path";
import { expect, it as baseIt } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { expectedCompactionSummary } from "../../agents/test-helpers/compaction-checkpoint.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore as boundedContext } from "./session-accessor.sqlite-active-context.js";
import { readSessionTranscriptBoundedMessageTailPage as tailPage } from "./session-accessor.sqlite-active-events.js";
import { readActiveTranscriptStats as activeStats } from "./session-accessor.sqlite-history.test-support.js";
import { prepareSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { waitForSessionTranscriptProjection as waitProjection } from "./session-transcript-reconcile.js";

// Split from session-accessor.sqlite-bounded-context.test.ts with its fixture: the fork's compaction
// checkpoint line (expectedCompactionSummary) grows this case, and that file is held at its
// grandfathered line count.

type Scope = { agentId: string; sessionId: string; sessionKey: string; storePath: string };

function eventIds(events: unknown[]) {
  return events.map((event) => (event as { id: string }).id);
}

function readHistory(scope: Scope) {
  return tailPage(scope, { maxBytes: 1024 * 1024, maxMessages: 100, offset: 0 });
}

async function withBoundedContextScope(run: (scope: Scope) => Promise<void>): Promise<void> {
  await withOpenClawTestState({ label: "bounded-transcript-context" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    const scope = {
      agentId: "main",
      sessionId: "bounded-context",
      sessionKey: "agent:main:bounded-context",
      storePath: path.join(state.sessionsDir("main"), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await run(scope);
  });
}

const it = baseIt.extend<{ scope: Scope }>({
  scope: async ({ task: _task }, use) => withBoundedContextScope(use),
});

it("keeps reset history closed across compaction with a warm history cache", async ({ scope }) => {
  const manager = SessionManager.open(scope);
  const appendUser = (content: string) =>
    manager.appendMessage({ role: "user", content, timestamp: 1 });
  const expectHistory = async (ids: string[]) => {
    manager.flushPendingPersistence();
    await waitProjection(scope);
    const page = readHistory(scope);
    expect(page.totalMessages).toBe(ids.length);
    expect(page.events.map(({ event }) => (event as { id: string }).id)).toEqual(ids);
    const hydrated = await prepareSessionTranscriptHydration(scope, { compaction: true }).read();
    expect(hydrated.kind).toBe("bounded");
    expect(hydrated.snapshot).toEqual(boundedContext(scope, { compaction: true }));
  };
  const expectContext = (messages: unknown[]) => {
    expect(manager.buildSessionContext().messages).toMatchObject(messages);
    expect(activeStats(scope).eventCount).toBe(messages.length);
  };
  const summary = (text: string) => ({ role: "compactionSummary", summary: text });
  const message = (content: string) => ({ role: "user", content });

  appendUser("before-reset user");
  manager.appendMessage(
    makeAgentAssistantMessage({ content: [{ type: "text", text: "before-reset assistant" }] }),
  );
  const resetId = manager.appendResetBoundary("new");
  const abandoned = appendUser("abandoned branch");
  manager.branch(resetId);
  const freshUserId = appendUser("fresh user");
  await expectHistory([freshUserId]);
  expect(eventIds(boundedContext(scope, { compaction: true }).events)).not.toContain(abandoned);

  const freshCompactionId = manager.appendCompaction("fresh-only summary", freshUserId, 100);
  await expectHistory([freshUserId]);
  expectContext([
    summary(
      expectedCompactionSummary("fresh-only summary", {
        entryId: freshCompactionId,
        shadowedEntryCount: 1,
      }),
    ),
    message("fresh user"),
  ]);

  const nextUserId = appendUser("after compaction");
  await expectHistory([freshUserId, nextUserId]);
  expect(activeStats(scope).eventCount).toBe(3);

  manager.appendResetBoundary("new", nextUserId);
  const newestUserId = appendUser("after second reset");
  await expectHistory([nextUserId, newestUserId]);
  expectContext([message("after compaction"), message("after second reset")]);

  const newestCompactionId = manager.appendCompaction("newest-only summary", newestUserId, 100);
  await expectHistory([nextUserId, newestUserId]);
  const reopened = SessionManager.open(scope);
  expect(reopened.buildSessionContext().messages).toMatchObject([
    summary(
      expectedCompactionSummary("newest-only summary", {
        entryId: newestCompactionId,
        shadowedEntryCount: 2,
      }),
    ),
    message("after second reset"),
  ]);
  expect(activeStats(scope).eventCount).toBe(2);
});
