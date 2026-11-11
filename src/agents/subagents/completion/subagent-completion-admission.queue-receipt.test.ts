import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { bindSubagentRunRecord } from "../registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../registry/subagent-registry.store.kernel.js";
import { isSameSubagentRunOwner } from "../registry/subagent-run-generation.js";
import {
  SubagentCompletionSourceChangedError,
  mutateRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  admitCompletionFixtureDatabase,
  readCompletionSystemEvents,
} from "./subagent-completion-admission.test-helpers.js";
import type { RequesterWakeCommittedWrite } from "./subagent-completion-mutation.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("committed requester outcomes", () => {
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-requester-outcome-", resolvePreferredOpenClawTmpDir()),
    );
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("retains a failed completion without creating another parent input after publication fails", async () => {
    const now = Date.now();
    const entry = createSubagentRunRecord({
      runId: "blocked-requester-outcome",
      childSessionKey: "agent:main:subagent:blocked-outcome",
      requesterSessionKey: "agent:main:requester-outcome",
      requesterAgentId: "main",
      createdAt: now - 20,
      endedAt: now - 10,
      outcome: { status: "ok" },
      expectsCompletionMessage: true,
      cleanupHandled: true,
      completion: { required: true, resultText: "Synthetic child result", capturedAt: now - 10 },
      delivery: { status: "pending", generation: 1 },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        rearmGeneration: 1,
        batchRunIds: ["blocked-requester-outcome"],
      },
    });
    writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(entry)], []);
    subagentRuns.set(entry.runId, entry);
    const context = captureOpenClawStateWorkerContext();
    let committed: RequesterWakeCommittedWrite | undefined;
    const settle = (onPublished: () => void) =>
      mutateRequesterCompletionBatch({
        entries: [entry],
        operation: {
          kind: "settle",
          outcome: { delivered: false, path: "none", error: "Requester unavailable" },
        },
        context,
        assertCurrent: () => {
          if (!isSameSubagentRunOwner(subagentRuns.get(entry.runId), entry)) {
            throw new SubagentCompletionSourceChangedError(
              "Subagent completion owner changed before settlement",
            );
          }
        },
        committed,
        onCommitted: (receipt) => {
          committed = receipt;
        },
        onPublished,
      });
    await expect(
      settle(() => {
        throw new Error("Synthetic publication observer failure");
      }),
    ).rejects.toMatchObject({ outcome: "committed", publication: "published" });
    expect(readCompletionSystemEvents(database)).toEqual([]);
    expect(subagentRuns.get(entry.runId)?.delivery).toMatchObject({
      status: "failed",
      lastError: "Requester unavailable",
    });
    expect(subagentRuns.get(entry.runId)?.requesterSettleWake).toBeUndefined();
    // Reconciling the committed receipt must not write the outcome again.
    database.db.exec(
      "CREATE TRIGGER reject_replay BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'outcome replayed'); END",
    );
    try {
      await expect(settle(() => {})).resolves.toEqual({ applied: true, publication: "published" });
    } finally {
      database.db.exec("DROP TRIGGER reject_replay");
    }
    expect(readCompletionSystemEvents(database)).toEqual([]);
  });
});
