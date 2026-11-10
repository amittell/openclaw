import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { assert, expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  createReplyOperation,
  isReplyRunSuccessorAdmissionBlocked,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

// A /stop dispatched with its reply delivery held, then the next turn in the same session,
// admitted through the reply-turn gate that visible messages and queued follow-ups share.
async function runStopThenNextTurn(active: boolean) {
  const state = await createOpenClawTestState({ label: "stop-transcript", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const sessionKey = "agent:main:telegram:direct:1001";
  const target = { agentId: "main", storePath, sessionKey, sessionId: "stop-session" };
  await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
  const persisted = createDeferred();
  let started = false;
  let rowsAtStart: number | undefined;
  let next: Promise<void> | undefined;
  const startNextTurn = () => {
    next = (async () => {
      const admitted = await admitReplyTurn({ ...target, kind: "visible", resetTriggered: false });
      assert(admitted.status === "owned");
      try {
        started = true;
        rowsAtStart = (await readVisibleSessionTranscriptMessageEntries(target)).length;
        // Stands in for the turn's persisted user row.
        await appendAssistantMessageToSessionTranscript({
          ...target,
          expectedSessionId: target.sessionId,
          idempotencyKey: "next-turn",
          text: "Next turn",
        });
        persisted.resolve();
      } finally {
        admitted.operation.complete();
      }
    })();
  };
  const stopped = active ? createReplyOperation({ ...target, resetTriggered: false }) : undefined;
  if (stopped) {
    stopped.attachBackend({
      kind: "embedded",
      isStreaming: () => true,
      // Input accepted after Stop's selection waits for the stopped run to clear.
      cancel: () => {
        startNextTurn();
        queueMicrotask(() => stopped.complete());
      },
    });
    stopped.setPhase("running");
  }
  const delivering = createDeferred();
  const releaseDelivery = createDeferred();
  const dispatcher = createReplyDispatcher({
    deliver: async () => {
      delivering.resolve();
      await releaseDelivery.promise;
      return { visibleReplySent: true };
    },
  });
  const stop = withReplyDispatcher({
    dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        cfg: { session: { store: storePath } },
        dispatcher,
        ctx: {
          Body: "/stop",
          CommandBody: "/stop",
          CommandAuthorized: true,
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
          From: "telegram:1001",
          To: "telegram:2002",
          SessionKey: sessionKey,
          MessageSid: `stop-${String(active)}`,
        },
      }),
  });
  await delivering.promise;
  if (!active) {
    startNextTurn();
  }
  // The ack is undelivered. Without a successor hold, or once the next turn holds the run
  // slot, nothing stops it from writing first, so let it.
  const held = isReplyRunSuccessorAdmissionBlocked(sessionKey);
  const owner = replyRunRegistry.get(sessionKey);
  if (!held || started || (owner !== undefined && owner !== stopped)) {
    await persisted.promise;
  }
  releaseDelivery.resolve();
  await Promise.all([stop, next]);
  const entries = await readVisibleSessionTranscriptMessageEntries(target);
  return {
    held,
    rowsAtStart,
    rows: entries.map(
      ({ message: row }) => String(Reflect.get(row, "idempotencyKey")).split(":")[0],
    ),
  };
}

it.each([false, true])(
  "records a late-delivered /stop before the next turn's row (active run: %s)",
  async (active) => {
    const outcome = await runStopThenNextTurn(active);
    expect(outcome.rows).toEqual(["command-input", "command-reply", "next-turn"]);
    // The next turn starts only after the exchange is recorded, not merely delivered.
    expect(outcome.rowsAtStart).toBe(2);
    expect(outcome.held).toBe(true);
  },
);
