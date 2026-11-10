import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { withReplyDispatcher } from "../../../auto-reply/dispatch-dispatcher.js";
import { dispatchReplyFromConfig } from "../../../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../../../auto-reply/reply/reply-dispatcher.js";
import { isReplyRunSuccessorAdmissionBlocked } from "../../../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../../../auto-reply/reply/reply-turn-admission.js";
import { loadTranscriptEventsSync } from "../../../config/sessions/session-accessor.js";
import {
  createAssistant,
  createAssistantResultStream,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { withInterruptedTurn, withReplaySession } from "./attempt-session-replay.test-support.js";

registerAgentSessionLoopTestLifecycle();

type ReplayTarget = Parameters<
  NonNullable<NonNullable<Parameters<typeof withInterruptedTurn>[2]>["admitUserTurn"]>
>[0];

// The next accepted input persists its user row once its reply turn is admitted.
async function admitNextTurn(target: ReplayTarget, persist: () => Promise<unknown>) {
  const admitted = await admitReplyTurn({ ...target, kind: "visible", resetTriggered: false });
  assert(admitted.status === "owned");
  try {
    return await persist();
  } finally {
    admitted.operation.complete();
  }
}

async function replayNextTurn(params: {
  selectedOwner: boolean;
  admitUserTurn: (target: ReplayTarget, persist: () => Promise<unknown>) => Promise<unknown>;
  afterReplayPreparation?: () => Promise<unknown>;
}) {
  const outcome: { rows?: string[]; modelCalls?: number; answer?: string } = {};
  await withInterruptedTurn(
    false,
    async (fixture) => {
      const { attempt, target } = fixture;
      await withReplaySession(
        fixture,
        false,
        async (session, submit) => {
          streamMocks.streamSimple.mockImplementation((model) =>
            createAssistantResultStream(
              createAssistant(model, [{ type: "text", text: "FOLLOWUP_ANSWERED" }]),
            ),
          );
          await submit();
          outcome.modelCalls = streamMocks.streamSimple.mock.calls.length;
          outcome.answer = session.getLastAssistantText();
          outcome.rows = loadTranscriptEventsSync(target).flatMap((entry) => {
            const key = isRecord(entry) && isRecord(entry.message) && entry.message.idempotencyKey;
            return typeof key === "string" && /^command-|:user$/.test(key)
              ? [key === `${attempt.runId}:user` ? "user" : (key.split(":")[0] ?? key)]
              : [];
          });
        },
        params.afterReplayPreparation
          ? { afterReplayPreparation: params.afterReplayPreparation }
          : {},
      );
    },
    // The session already has history, as a stopped conversation does.
    {
      selectedOwner: params.selectedOwner,
      settledPrefix: true,
      admitUserTurn: params.admitUserTurn,
    },
  );
  return outcome;
}

it.each([false, true])(
  "replays a turn admitted after a /stop whose reply is delivered late (selected reader: %s)",
  async (selectedOwner) => {
    const delivering = createDeferred();
    const releaseDelivery = createDeferred();
    let stop: Promise<unknown> | undefined;
    // The Stop reply's delivery, and so its command exchange, completes inside the replay window.
    const deliverStop = vi.fn(async () => {
      releaseDelivery.resolve();
      await stop;
    });
    const outcome = await replayNextTurn({
      selectedOwner,
      afterReplayPreparation: deliverStop,
      admitUserTurn: async (target, persist) => {
        const dispatcher = createReplyDispatcher({
          deliver: async () => {
            delivering.resolve();
            await releaseDelivery.promise;
            return { visibleReplySent: true };
          },
        });
        stop = withReplyDispatcher({
          dispatcher,
          run: () =>
            dispatchReplyFromConfig({
              cfg: { session: { store: target.storePath } },
              dispatcher,
              ctx: {
                Body: "/stop",
                RawBody: "/stop",
                CommandBody: "/stop",
                CommandAuthorized: true,
                Provider: "telegram",
                Surface: "telegram",
                ChatType: "direct",
                From: "telegram:1001",
                To: "telegram:2002",
                SessionKey: target.sessionKey,
                MessageSid: `stop-${String(selectedOwner)}`,
              },
            }),
        });
        await delivering.promise;
        const turn = admitNextTurn(target, persist);
        // A held turn waits for the Stop's exchange, so let the ack land. Without the hold,
        // the turn writes now and the exchange lands inside its replay window.
        if (isReplyRunSuccessorAdmissionBlocked(target.sessionKey)) {
          releaseDelivery.resolve();
        }
        return await turn;
      },
    });
    expect(deliverStop).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      modelCalls: 1,
      answer: "FOLLOWUP_ANSWERED",
      rows: ["command-input", "command-reply", "user"],
    });
  },
);

it.each([false, true])(
  "control: an ordinary next turn with no /stop replays once (selected reader: %s)",
  async (selectedOwner) => {
    const outcome = await replayNextTurn({ selectedOwner, admitUserTurn: admitNextTurn });
    expect(outcome).toEqual({ modelCalls: 1, answer: "FOLLOWUP_ANSWERED", rows: ["user"] });
  },
);
