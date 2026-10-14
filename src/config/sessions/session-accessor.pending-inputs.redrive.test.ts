import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "./session-accessor.pending-inputs.js";
import { useTempSessionsFixture } from "./test-helpers.js";

// Split out of session-accessor.pending-inputs.test.ts rather than appended to it:
// that file sits just under the 1000-line max-lines cap, and this case pushes it
// over. The repo forbids a max-lines suppression, so the seam is a sibling file.
describe("committed source-turn re-drive", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-redrive-");
  const sessionKey = "agent:main:pending-inputs-redrive";
  const sessionId = "pending-session-redrive";
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const message = (runId: string, content = "Continue the task"): PersistedUserTurnMessage => ({
    role: "user",
    content,
    timestamp: 100,
    idempotencyKey: `${runId}:user`,
  });

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("suppresses a re-driven committed source turn id instead of admitting a fresh agent turn", async () => {
    // First admission: stage the inbound source turn, execute it to committed.
    // The channel source turn id is the message idempotency key; the run id is
    // distinct and randomized per execution (get-reply-run-execute attaches
    // sourceTurnId as the user-turn idempotencyKey).
    const target = { ...scope(), sessionEntry: undefined };
    const sourceTurnId = "channel-user:v1:deadbeef";
    const sourceMessage: PersistedUserTurnMessage = {
      ...message("driven-run", "Drive me once"),
      idempotencyKey: sourceTurnId,
    };
    const original = createUserTurnTranscriptRecorder({
      target,
      message: sourceMessage,
    });
    const originalStaged = await original.stageApproved?.({
      runId: "driven-run",
      assertCurrent: () => {},
    });
    expect(originalStaged).toBe(true);
    // The owning run executes: the user message commits to the transcript and the
    // pending-input row is consumed (deleted).
    await original.withPendingInput?.(() => original.persistApproved());
    const committedTranscript = await loadTranscriptEvents(scope());
    expect(
      committedTranscript.some(
        (event) =>
          asOptionalRecord(event)?.type === "message" &&
          asOptionalRecord(asOptionalRecord(event)?.message)?.idempotencyKey === sourceTurnId,
      ),
    ).toBe(true);
    expect(await listSessionPendingInputs(scope())).toEqual({ total: 0, items: [] });
    original.finishPendingInput?.("interrupted");

    // The owning run then died without a done signal; a later RE-DRIVE of the SAME
    // source turn id arrives with a NEW run id. The message is already committed,
    // so admission must report it as consumed: stageApproved must not approve a
    // fresh agent turn for the replayed input.
    const reDriven = createUserTurnTranscriptRecorder({
      target,
      message: {
        ...sourceMessage,
        // A re-drive replays the SAME committed source bytes under a NEW run id.
        timestamp: 200,
      },
    });
    const reDrivenStaged = await reDriven.stageApproved?.({
      runId: "re-driven-run",
      assertCurrent: () => {},
    });
    expect(reDrivenStaged).toBe(false);
    expect(reDriven.isPendingInputConsumed?.()).toBe(true);

    // No duplicate transcript message: the replayed append stays idempotent and no
    // fresh custody row is minted for the re-drive.
    const replayResult = await reDriven.withPendingInput?.(() => reDriven.persistApproved());
    expect(replayResult?.appended).toBe(false);
    expect(await loadTranscriptEvents(scope())).toEqual(committedTranscript);
    expect(await listSessionPendingInputs(scope())).toEqual({ total: 0, items: [] });
    reDriven.finishPendingInput?.("interrupted");
  });
});

// The channel-bound terminal arm above must not swallow a private-completion retry:
// stageSessionPendingInput checks `trackCompletion` before the key space, because that
// retry's completion is owned by the input-completion receipt, not by this seam. The
// fixture puts a trackCompletion stage under a channel-user key to isolate that order.
describe("trackCompletion retry of a committed channel-bound input", () => {
  const fixture = useTempSessionsFixture("openclaw-pending-inputs-redrive-private-");
  const scope = () => ({
    agentId: "main",
    sessionKey: "agent:main:pending-inputs-redrive-private",
    sessionId: "pending-session-redrive-private",
    storePath: fixture.storePath(),
  });
  const runId = "channel-user:v1:private";
  const privateMessage: PersistedUserTurnMessage = {
    role: "user",
    content: "private child result",
    timestamp: 1,
    idempotencyKey: `${runId}:user`,
    display: false,
    provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
  };
  const receipts: SessionPendingInputReceipt[] = [];
  const stage = async (trackCompletion: boolean, stageRunId = runId) => {
    const receipt = expectDefined(
      await stageSessionPendingInput(scope(), {
        runId: stageRunId,
        trackCompletion,
        assertCurrent: () => {},
        message: privateMessage,
      }),
      "Expected staged input",
    );
    receipts.push(receipt);
    return receipt;
  };
  /** The owning run commits the input to the transcript, then its process restarts. */
  const commit = async (receipt: SessionPendingInputReceipt) => {
    expect(
      receipt.run(() => appendTranscriptMessageSync(scope(), { message: receipt.message })),
    ).toMatchObject({ ok: true, value: { appended: true } });
    receipt.finish("interrupted");
    rotateAgentEventLifecycleGeneration();
    await receipt.settled?.();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  };

  beforeEach(async () => {
    await upsertSessionEntryCore(scope(), { sessionId: scope().sessionId, updatedAt: 1 });
  });
  afterEach(async () => {
    const retained = receipts.splice(0);
    for (const receipt of retained) {
      receipt.finish("interrupted");
    }
    await Promise.allSettled(retained.map(async (receipt) => receipt.settled?.()));
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
  });

  it("admits the retry as queued instead of consuming it under the channel-bound key", async () => {
    await commit(await stage(true));
    const retry = await stage(true);
    expect(retry.state).toBe("queued");
    expect(retry.completion).toBeUndefined();
    expect(retry.run(() => "resumed")).toBe("resumed");
    await retry.completeAsync!(buildAgentRunTerminalOutcome({ status: "ok" }));
  });

  it("consumes the same committed channel-bound input when it is not a trackCompletion retry", async () => {
    await commit(await stage(false));
    const reDriven = await stage(false, "re-driven-run");
    expect(reDriven.state).toBe("consumed");
  });
});
