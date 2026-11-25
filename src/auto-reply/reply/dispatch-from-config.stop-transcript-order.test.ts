import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, onTestFinished } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

// Upstream #195612 (272d4c60652b) adds this case to dispatch-from-config.command-transcript.test.ts;
// the carry keeps it in its own file so beta.3's command-transcript test stays upstream's.
it.each([false, true])(
  "records a late-delivered /stop before the next turn's row (active run: %s)",
  async (active) => {
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
      next = withSessionTurn(target, async () => {
        started = true;
        rowsAtStart = (await readVisibleSessionTranscriptMessageEntries(target)).length;
        await appendAssistantMessageToSessionTranscript({
          ...target,
          expectedSessionId: target.sessionId,
          idempotencyKey: "next-turn",
          text: "Next turn",
        });
        persisted.resolve();
      });
    };
    if (active) {
      const operation = createReplyOperation({
        agentId: "main",
        sessionKey,
        sessionId: target.sessionId,
        target: captureSessionTarget({
          agentId: "main",
          sessionKey,
          storeScope: storePath,
          incarnation: target.sessionId,
        }),
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        isStreaming: () => true,
        // Input accepted after Stop's selection waits for the stopped run to clear.
        cancel: () => {
          startNextTurn();
          queueMicrotask(() => operation.complete());
        },
      });
      operation.setPhase("running");
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    // A turn admitted while the ack is still in flight writes ahead of the Stop's exchange.
    if (started) {
      await persisted.promise;
    }
    releaseDelivery.resolve();
    await Promise.all([stop, next]);
    const entries = await readVisibleSessionTranscriptMessageEntries(target);
    expect(
      entries.map(({ message }) => String(Reflect.get(message, "idempotencyKey")).split(":")[0]),
    ).toEqual(["command-input", "command-reply", "next-turn"]);
    // The next turn starts only after the exchange is recorded, not merely delivered.
    expect(rowsAtStart).toBe(2);
  },
);
