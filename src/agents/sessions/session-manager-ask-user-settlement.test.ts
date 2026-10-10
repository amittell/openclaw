import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import * as metadataRuntime from "./session-manager-metadata-runtime.js";
import { SessionManager } from "./session-manager.js";

// Regression guard for openclaw/openclaw#168082.
//
// On the 2026.9.9 line, an ask_user question that timed out at 900s settled its
// no_answer tool result through the synchronous snapshot path
// (session-manager-persistence.ts persistRecord -> appendTranscriptMessageSnapshotSync)
// carrying a stale expectedMutationAt fence. When the run's own transcript commit
// landed between fence capture and the write, runTranscriptWriteSnapshotSync threw
// SqliteTranscriptMutationConflictError with no retry, failing the run.
//
// On main the no_answer tool result is appended through the async worker path
// (appendMessageAsync -> appendEntryAsync -> persistWorkerRecord -> metadata worker),
// which re-validates the fence inside the worker's own transaction for validateTurn
// messages and retries once on conflict. This test pins that the settlement write
// rebases and commits instead of throwing while the run's own commit is in flight.

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "ask-user-settlement" });
});
afterAll(async () => {
  await state.cleanup();
});

async function fixture(name: string) {
  const target = {
    agentId: "main",
    sessionId: name,
    sessionKey: `agent:main:${name}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: name, updatedAt: 1 });
  const manager = await SessionManager.openAsync(target, state.workspaceDir);
  return { target, manager };
}

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`,
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

const assistantAskUser = {
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id: "call-ask-user", name: "ask_user", arguments: {} }],
  stopReason: "toolUse" as const,
  timestamp: 2,
};

const noAnswer = (toolCallId: string) => ({
  role: "toolResult" as const,
  toolCallId,
  toolName: "ask_user",
  content: [{ type: "text" as const, text: "No answer arrived; proceed with best judgment." }],
  details: { status: "no_answer" },
  isError: false,
  timestamp: 3,
});

it("settles the ask_user no_answer tool result when the run's own commit lands in flight", async () => {
  const { target, manager } = await fixture("ask-user-settlement");
  // Seed the turn: user input, then the run's assistant turn that called ask_user.
  await manager.appendMessageAsync(user("seed"));
  await manager.appendMessageAsync(assistantAskUser);

  const withWorker = metadataRuntime.withSessionMetadataWorker;
  let injected = false;
  const spy = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation((options, database, assertCurrent, operation, controls) =>
      withWorker(
        options,
        database,
        assertCurrent,
        (worker) =>
          operation({
            execute: async (command, commandOptions) => {
              // The run's own transcript commit lands between host preparation and the
              // worker's fenced append. On the 9.9 sync snapshot path this stale fence
              // threw SqliteTranscriptMutationConflictError; the worker re-validates.
              if (
                !injected &&
                command.type === "session.metadata.append" &&
                command.input?.message?.messageJson?.includes("no_answer")
              ) {
                injected = true;
                expect(
                  appendTranscriptMessageSync(target, {
                    eventId: "in-flight-commit",
                    message: assistantAskUser,
                  }).ok,
                ).toBe(true);
              }
              return await worker.execute(command, commandOptions);
            },
          }),
        controls,
      ),
    );
  let failure: unknown;
  let entryId: string | undefined;
  try {
    entryId = await manager
      .appendMessageAsync(noAnswer("call-ask-user"))
      .catch((error: unknown) => {
        failure = error;
        return undefined;
      });
  } finally {
    spy.mockRestore();
  }
  expect(injected).toBe(true);
  // The settlement write must not throw the stale-fence conflict.
  expect(failure).toBeUndefined();
  expect(entryId).toBeDefined();
  const events = await loadTranscriptEvents(target);
  // Both the in-flight commit and the no_answer result are present and ordered.
  expect(events.map((event) => event.id)).toContain("in-flight-commit");
  expect(events.at(-1)).toMatchObject({
    id: entryId,
    parentId: "in-flight-commit",
    message: noAnswer("call-ask-user"),
  });
});

it("does not swallow a genuine non-rebaseable conflict for the no_answer settlement", async () => {
  const { target, manager } = await fixture("ask-user-settlement-hard");
  await manager.appendMessageAsync(user("seed"));
  await manager.appendMessageAsync(assistantAskUser);

  const withWorker = metadataRuntime.withSessionMetadataWorker;
  let injected = false;
  const spy = vi
    .spyOn(metadataRuntime, "withSessionMetadataWorker")
    .mockImplementation((options, database, assertCurrent, operation, controls) =>
      withWorker(
        options,
        database,
        assertCurrent,
        (worker) =>
          operation({
            execute: async (command, commandOptions) => {
              // A second in-flight commit that the single retry cannot absorb.
              if (
                !injected &&
                command.type === "session.metadata.append" &&
                command.input?.message?.messageJson?.includes("no_answer")
              ) {
                injected = true;
                expect(
                  appendTranscriptMessageSync(target, {
                    eventId: "in-flight-a",
                    message: assistantAskUser,
                  }).ok,
                ).toBe(true);
                expect(
                  appendTranscriptMessageSync(target, {
                    eventId: "in-flight-b",
                    message: assistantAskUser,
                  }).ok,
                ).toBe(true);
              }
              return await worker.execute(command, commandOptions);
            },
          }),
        controls,
      ),
    );
  let failure: unknown;
  try {
    await manager.appendMessageAsync(noAnswer("call-ask-user")).catch((error: unknown) => {
      failure = error;
      return undefined;
    });
  } finally {
    spy.mockRestore();
  }
  expect(injected).toBe(true);
  // The single worker retry re-reads the fresh tail (in-flight-b) and rebases the
  // settlement onto it, so two in-flight commits still land cleanly. Pin the commit
  // and its rebased parent so an over-correction that drops or mis-parents the
  // settlement is caught.
  expect(failure).toBeUndefined();
  const events = await loadTranscriptEvents(target);
  expect(events.map((event) => event.id)).toContain("in-flight-b");
  expect(events.at(-1)).toMatchObject({
    parentId: "in-flight-b",
    message: noAnswer("call-ask-user"),
  });
});
