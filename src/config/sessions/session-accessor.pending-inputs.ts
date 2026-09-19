import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { sql } from "kysely";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
import {
  normalizeMessageClientSources,
  readMessageClientSources,
} from "../../chat/message-client-source.js";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import {
  getAgentEventLifecycleGeneration,
  assertAgentRunLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  ensureSessionPendingInputsSchema,
  ensureSessionInputCompletionsSchema,
  hasPendingInputConsumptionColumn,
  hasSessionPendingInputsSchema,
} from "../../state/openclaw-agent-pending-inputs-schema.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "./restart-recovery-state.js";
import {
  preparePendingInputRequest,
  matchesSessionPendingInputRequest,
} from "./session-accessor.pending-input-request.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import {
  claimCurrentSessionPendingInputDedupeRecovery,
  isFinalInputCompletion,
  readSessionInputCompletion,
  writeSessionInputCompletion,
  parseSessionPendingInputMessage,
  projectSessionPendingInput,
  readSessionPendingInputByKey,
  readSessionPendingInputOwnerIds,
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
  type SessionPendingInputRow,
  type SessionPendingInputState,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  readMessageIdempotencyKey,
  readTranscriptMessageByScopedIdempotencyKey,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
type PendingInputScope = SessionAccessScope & { agentId: string; sessionId: string };
export type SessionPendingInputReceipt = {
  state: "queued" | "consumed";
  inputId: string;
  /** Stage-time request identity, taken before hooks and storage redaction. */
  requestHash?: string;
  message: PersistedUserTurnMessage;
  run: <T>(operation: () => T) => T;
  finish: (disposition: Exclude<SessionPendingInputState, "queued">) => void;
  completion?: AgentRunTerminalOutcome;
  complete?: (outcome: AgentRunTerminalOutcome) => AgentRunTerminalOutcome;
};
const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();

function ownerReceipt(
  owner: SessionPendingInputOwner,
  requestHash?: string,
): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    state: "queued",
    inputId: owner.inputId,
    ...(requestHash ? { requestHash } : {}),
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    finish: owner.finish,
  };
  receiptOwners.set(receipt, owner);
  return receipt;
}

/** Install only a private receipt's persistence context; this does not reopen execution authority. */
export function withSessionPendingInputPersistence<T>(
  receipt: SessionPendingInputReceipt,
  persist: () => T,
): T {
  const owner = receiptOwners.get(receipt);
  return owner ? runWithSessionPendingInputPersistence(owner, persist) : receipt.run(persist);
}

/** Bind one collected message to its private admitted sources without creating another durable queue. */
export function bindSessionPendingInputSources(
  receipts: readonly SessionPendingInputReceipt[],
  message: PersistedUserTurnMessage,
): SessionPendingInputReceipt | undefined {
  const sources = [
    ...new Set(
      receipts.flatMap((receipt) => {
        if (receipt.state === "consumed") {
          throw new Error("Collected input has already been consumed");
        }
        const owner = receiptOwners.get(receipt);
        return owner ? (owner.sources ?? [owner]) : [];
      }),
    ),
  ];
  const first = sources[0];
  if (!first) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (
    !idempotencyKey ||
    sources.some(
      (source) =>
        source.databasePath !== first.databasePath ||
        source.sessionId !== first.sessionId ||
        source.sessionKey !== first.sessionKey ||
        source.idempotencyKey === idempotencyKey,
    )
  ) {
    throw new Error("Collected input requires one exact session and a distinct aggregate identity");
  }
  // Collected framing still passes storage redaction; its staged sources have
  // already passed approval and must not run through another plugin hook.
  const clients = normalizeMessageClientSources(
    receipts.flatMap((receipt) => readMessageClientSources(receipt.message)),
  );
  const collectedMessage = { ...message };
  if (clients.length) {
    collectedMessage["__openclaw"] = {
      ...message["__openclaw"],
      transport: { ...asOptionalRecord(message["__openclaw"]?.transport), clients },
    };
  }
  const messageJson = JSON.stringify(
    redactTranscriptMessageForStorage(collectedMessage, { config: sources.at(-1)?.config }),
  );
  if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Collected input exceeds the Gateway payload limit");
  }
  const aggregateInputId = randomUUID();
  return ownerReceipt({
    ...first,
    inputId: aggregateInputId,
    transcriptInputId: aggregateInputId,
    idempotencyKey,
    messageJson,
    sources,
    finish: (disposition) => {
      const failures: unknown[] = [];
      for (const source of sources) {
        try {
          source.finish(disposition);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Failed to finish collected input custody");
      }
    },
  });
}

/** Bounded window for the answered-turn marker; mirrors the heartbeat duplicate guard. */
const COMPLETED_TURN_MARKER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Minted per inbound messageId by auto-reply/reply/source-turn-id.ts. */
const CHANNEL_USER_KEY_PREFIX = "channel-user:v1:";

/**
 * Request identity for one accepted user turn. Taken from the SUBMITTED message with
 * only `timestamp` removed, so it is computed before `prepareMessageAfterIdempotencyCheck`
 * (plugin hooks) and before `redactTranscriptMessageForStorage` ever run. It is therefore
 * NOT recoverable from committed transcript bytes: carriers must keep the stage-time value.
 */
export function computeSessionPendingInputRequestHash(
  message: PersistedUserTurnMessage,
  requestFingerprint?: string,
): string {
  // One definition with the stage path: the answered-turn marker must compare equal.
  return preparePendingInputRequest(message, requestFingerprint).requestHash;
}

/**
 * Record that the run carrying this request reached `final`. Fire-and-forget bookkeeping
 * after an already-succeeded turn: the patch re-reads the target and writes only while the
 * session id is unchanged, so a rotated session drops the marker instead of stamping a
 * stranger's entry. A lost write only re-admits a later re-presentation; it can never
 * retire a turn that was not answered.
 */
export async function recordSessionPendingInputCompletedTurn(
  scope: SessionAccessScope,
  options: { expectedSessionId: string; requestHash: string; completedAt?: number },
): Promise<void> {
  const completedAt = options.completedAt ?? Date.now();
  await patchSessionEntryCore(
    scope,
    (_entry, context) =>
      context.existingEntry?.sessionId === options.expectedSessionId
        ? {
            lastCompletedTurnRequestHash: options.requestHash,
            lastCompletedTurnAt: completedAt,
          }
        : null,
    { preserveActivity: true },
  );
}

/** Accept durable input without changing the active transcript or scheduling execution. */
export async function stageSessionPendingInput(
  scope: PendingInputScope,
  options: {
    runId: string;
    /** Authenticated ingress binds raw input before randomized media preparation. */
    requestFingerprint?: string;
    /** Records processing completion separately from canonical transcript consumption. */
    trackCompletion?: boolean;
    message: PersistedUserTurnMessage;
    prepareMessageAfterIdempotencyCheck?: (
      message: PersistedUserTurnMessage,
    ) => PersistedUserTurnMessage | undefined;
    config?: OpenClawConfig;
    assertCurrent: () => void;
    /** Retained only after the full admission checks and custody transaction commit. */
    assertAdmittedCurrent?: () => void;
    assertCompletionCurrent?: () => void;
  },
): Promise<SessionPendingInputReceipt | undefined> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const idempotencyKey = readMessageIdempotencyKey(options.message);
  if (!idempotencyKey || !options.runId) {
    throw new Error("Pending input requires an exact run and message idempotency key");
  }
  const { stableMessage, requestHash } = preparePendingInputRequest(
    options.message,
    options.requestFingerprint,
  );
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () => {
      options.assertCurrent();
      const database = openOpenClawAgentDatabase(databaseOptions);
      // Read the row ONCE: the committed-replay branch below needs the same entry for the
      // restart-recovery claim and the answered-turn marker, and re-reading it there asks
      // this exclusive write for the same row twice.
      const sessionEntry = readSessionEntryRow(database, resolved.sessionKey)?.entry;
      if (sessionEntry?.sessionId !== scope.sessionId) {
        return undefined;
      }
      const existing = readSessionPendingInputByKey(database, resolved, idempotencyKey);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      let finished = false;
      let complete: SessionPendingInputReceipt["complete"];
      if (options.trackCompletion) {
        ensureSessionInputCompletionsSchema(database.db);
        const completionScope = {
          sessionKey: resolved.sessionKey,
          sessionId: scope.sessionId,
          idempotencyKey,
          runId: options.runId,
          requestHash,
          lifecycleGeneration,
        };
        const previous = readSessionInputCompletion(database, completionScope);
        if (
          previous &&
          (previous.request_hash !== requestHash || previous.run_id !== options.runId)
        ) {
          throw new Error("Input completion idempotency key conflicts with the accepted input");
        }
        if (previous && isFinalInputCompletion(previous.outcome)) {
          return {
            state: "consumed",
            inputId: idempotencyKey,
            message: options.message,
            completion: previous.outcome,
            run: () => {
              throw new Error("Input processing has already completed");
            },
            finish: () => {},
          };
        }
        complete = (outcome) =>
          runOpenClawAgentWriteTransaction((current) => {
            if (finished) {
              throw new Error("Input completion owner has already been released");
            }
            // Abort may itself be the outcome. The producer still must own the
            // original controller, lifecycle and session at the commit boundary.
            (options.assertCompletionCurrent ?? options.assertCurrent)();
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            if (
              readSessionEntryRow(current, resolved.sessionKey)?.entry.sessionId !== scope.sessionId
            ) {
              throw new Error("Input completion no longer owns the admitted session");
            }
            return writeSessionInputCompletion(current, completionScope, outcome);
          }, databaseOptions);
      }
      if (existing) {
        if (
          !matchesSessionPendingInputRequest(existing, stableMessage, requestHash) ||
          existing.run_id !== options.runId
        ) {
          throw new Error("Pending input idempotency key conflicts with the accepted input");
        }
        if (existing.consumed_event_id != null) {
          return {
            state: "consumed",
            inputId: existing.input_id,
            requestHash,
            message: parseSessionPendingInputMessage(existing.message_json),
            run: () => {
              throw new Error("Pending input has already been consumed");
            },
            finish: () => {},
          };
        }
        if (readSessionPendingInputOwnerIds(database, [existing]).has(existing.input_id)) {
          throw new Error("Pending input is already admitted; wait for its current turn");
        }
        if (
          (!options.requestFingerprint && !options.trackCompletion) ||
          (existing.state !== "queued" && existing.state !== "interrupted") ||
          (existing.lifecycle_generation === lifecycleGeneration && !options.trackCompletion)
        ) {
          throw new Error("Pending input ownership ended; submit a new turn to continue");
        }
      }
      const committed = readTranscriptMessageByScopedIdempotencyKey(
        database,
        resolved,
        idempotencyKey,
        "scan",
      );
      if (committed) {
        const committedMessage = parseSessionPendingInputMessage(JSON.stringify(committed.message));
        if (options.trackCompletion) {
          const prepared = options.prepareMessageAfterIdempotencyCheck
            ? options.prepareMessageAfterIdempotencyCheck(options.message)
            : options.message;
          if (!prepared) {
            return undefined;
          }
          const { timestamp: _preparedTimestamp, ...stablePrepared } =
            redactTranscriptMessageForStorage(prepared, { config: options.config });
          const { timestamp: _committedTimestamp, ...stableCommitted } = committedMessage;
          if (stableStringify(stablePrepared) !== stableStringify(stableCommitted)) {
            throw new Error("Input completion retry conflicts with the committed input");
          }
        }
        // A committed source turn is terminal at admission only when THIS request was
        // already ANSWERED - not merely committed. A re-presentation of an answered turn
        // and a re-drive of a turn that DIED mid-run both reach this branch with
        // `existing` null, the same idempotency key and identical bodies, so neither the
        // key's shape nor the run id separates them: every production caller of
        // stageApproved builds the key as `<runId>:user` from the same runId it passes,
        // which made the old key-ownership predicate always true and its consumed arm
        // dead code.
        //
        // The separating evidence is the answered-turn marker on the session entry,
        // written fire-and-forget only when a run reaches `final`. Consume only when the
        // marker names THIS request, was stamped at or after the committed message was
        // written, and is inside the bounded window; otherwise admit, so a died turn
        // still gets its answer. Two identical bodies under DIFFERENT idempotency keys
        // never meet here at all - they resolve to separate committed rows.
        // TWO RULES LIVE HERE, split by KEY SPACE, and they are deliberately not one.
        //
        // A channel-bound key (`channel-user:v1:<hash>`, minted per inbound messageId in
        // auto-reply/reply/source-turn-id.ts) is deterministic for one message, so a
        // committed hit under it is a re-drive by definition - body or not. A re-queued
        // update can arrive with its body LOST, which no content compare can see. It is
        // therefore terminal unless a pending, non-terminal restart-recovery claim must
        // re-deliver this exact source; a delivered-terminal receipt is a durable
        // "already delivered" outcome and does NOT authorize one.
        //
        // The arm is chosen by KEY SPACE, not by whose run id the key carries. Key ownership
        // was the predicate before this merge and it cannot decide this: an in-process retry
        // does arrive as "<runId>:user" under that same runId, but a retry that crosses a
        // RECORDER boundary carries the ORIGINAL run's key under a NEW run id (9ac9aecaa2d),
        // and so does restart recovery - both would read as "not mine" and be consumed.
        const channelBoundKey = idempotencyKey.startsWith(CHANNEL_USER_KEY_PREFIX);
        // Recovery is an override on both arms: restart recovery re-drives a source turn
        // under a NEW recovery run id, so its key belongs to the ORIGINAL run and never to
        // this one. Consuming it there drops the legitimate re-delivery (#9's P1, and the
        // case PR #10's guard exists for). So a pending claim that still owes THIS source
        // keeps the replay admitted.
        //
        // A delivered-terminal receipt is a durable "already delivered" outcome that
        // coexists with the live claim until the atomic claim/tombstone cleanup, so it does
        // NOT authorize a re-drive; terminal-pending and delivery-ambiguous still do, by
        // design.
        //
        // Acknowledged window (adversarial review 2026-09-15): while a claim is live this
        // seam cannot tell the ingress watchdog's re-queue of that source from the recovery
        // dispatch's own redelivery, so it fails open (admit) toward recovery. The ambiguity
        // self-resolves once the claim clears (delivered-terminal / tombstone).
        //
        // Both key forms are matched because a claim records the source TURN id while the
        // replay may arrive as "<sourceTurnId>:user".
        const sourceTurnId = idempotencyKey.endsWith(":user")
          ? idempotencyKey.slice(0, -":user".length)
          : idempotencyKey;
        const requiresRecoveryRedelivery =
          sessionEntry?.restartRecoveryDeliveryReceiptState !== "delivered-terminal" &&
          (hasRestartRecoverySourceClaim(sessionEntry, idempotencyKey) ||
            hasRestartRecoverySourceClaim(sessionEntry, sourceTurnId)) &&
          !hasRestartRecoveryTerminalRun(sessionEntry, idempotencyKey) &&
          !hasRestartRecoveryTerminalRun(sessionEntry, sourceTurnId);
        // THE COLLAPSED RULE (b386f827465 required this of whoever merged it: two rules
        // lived at this seam, split by key space, and only one copy may survive).
        //
        // The key space decides WHICH question to ask, and the answer is one expression:
        //   channel-user:v1:<hash>  deterministic per inbound messageId, so a committed hit
        //                           is a re-drive by definition, body or not -> terminal,
        //                           unless a live claim still owes this source.
        //   everything else         run-id keys ("<runId>:user", every production
        //                           stageApproved caller) carry no such determinism: an
        //                           ANSWERED
        //                           turn and a re-drive of a turn that DIED mid-run arrive
        //                           identically. Answering "queued" whenever the key looked
        //                           like this run's (the predicate before this merge) meant
        //                           an answered turn re-ran; answering "consumed" would drop
        //                           a turn that died mid-run and never answer it at all. The
        //                           answered-turn marker is the only thing that separates
        //                           them, so it, not key ownership, is the terminal test.
        const completedTurnAt = sessionEntry?.lastCompletedTurnAt;
        const committedAt =
          typeof committedMessage.timestamp === "number" ? committedMessage.timestamp : 0;
        const now = Date.now();
        // Content-scoped and bounded, following the heartbeat repeated-relay guard
        // (37ea9f110ba): a stale or clock-skewed marker must not consume a live turn.
        const answeredAlready =
          sessionEntry?.lastCompletedTurnRequestHash === requestHash &&
          typeof completedTurnAt === "number" &&
          completedTurnAt >= committedAt &&
          completedTurnAt <= now &&
          now - completedTurnAt < COMPLETED_TURN_MARKER_WINDOW_MS;
        // 9.5's private-completion retries (trackCompletion) keep 9.5's contract and are
        // always admitted: the check above already proved the retry is the committed input,
        // and their completion is owned by the input-completion receipt, not by this seam.
        // The terminal rule below is for re-presented USER turns only.
        return {
          state:
            options.trackCompletion ||
            requiresRecoveryRedelivery ||
            (!channelBoundKey && !answeredAlready)
              ? "queued"
              : "consumed",
          inputId: committed.messageId,
          requestHash,
          message: committedMessage,
          run: (operation) => {
            options.assertCurrent();
            return operation();
          },
          finish: () => {
            finished = true;
          },
          ...(complete ? { complete } : {}),
        };
      }
      const prepared = existing
        ? parseSessionPendingInputMessage(existing.message_json)
        : options.prepareMessageAfterIdempotencyCheck
          ? options.prepareMessageAfterIdempotencyCheck(options.message)
          : options.message;
      if (!prepared) {
        return undefined;
      }
      const messageJson =
        existing?.message_json ??
        JSON.stringify(redactTranscriptMessageForStorage(prepared, { config: options.config }));
      if (Buffer.byteLength(messageJson, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new Error("Approved pending input exceeds the Gateway payload limit");
      }
      const inputId = existing?.input_id ?? randomUUID();
      ensureSessionPendingInputsSchema(database.db);
      const inserted = runOpenClawAgentWriteTransaction((current) => {
        options.assertCurrent();
        if (
          readSessionEntryRow(current, resolved.sessionKey)?.entry.sessionId !== scope.sessionId
        ) {
          return false;
        }
        if (existing) {
          // A reconnect supplies fresh admission, never the previous run's closure.
          // Keep accepted bytes and order; only wholly unconsumed input may change owners.
          const result = executeSqliteQuerySync(
            current.db,
            getSessionKysely(current.db)
              .updateTable("session_pending_inputs")
              .set({ state: "queued", lifecycle_generation: lifecycleGeneration })
              .where("input_id", "=", inputId)
              .where("session_key", "=", resolved.sessionKey)
              .where("session_id", "=", scope.sessionId)
              .where("run_id", "=", options.runId)
              .where("lifecycle_generation", "=", existing.lifecycle_generation)
              .where("request_hash", "=", requestHash)
              .where("message_json", "=", existing.message_json)
              .where("state", "=", existing.state)
              .where("consumed_event_id", "is", null),
          );
          return result.numAffectedRows === 1n;
        }
        executeSqliteQuerySync(
          current.db,
          getSessionKysely(current.db).insertInto("session_pending_inputs").values({
            input_id: inputId,
            session_key: resolved.sessionKey,
            session_id: scope.sessionId,
            idempotency_key: idempotencyKey,
            run_id: options.runId,
            request_hash: requestHash,
            message_json: messageJson,
            lifecycle_generation: lifecycleGeneration,
            state: "queued",
            accepted_at: Date.now(),
          }),
        );
        return true;
      }, databaseOptions);
      if (!inserted) {
        return undefined;
      }
      const owner: SessionPendingInputOwner = {
        inputId,
        transcriptInputId: inputId,
        sessionId: scope.sessionId,
        sessionKey: resolved.sessionKey,
        databasePath: database.path,
        idempotencyKey,
        lifecycleGeneration,
        messageJson,
        config: options.config,
        assertCurrent: options.assertAdmittedCurrent ?? options.assertCurrent,
        ...(existing ? { restartRecovered: true as const } : {}),
        finish: (disposition) => {
          if (finished) {
            return;
          }
          finished = true;
          // Release authority even if recording the terminal disposition fails.
          releaseSessionPendingInputOwner(owner);
          if (owner.consumed) {
            return;
          }
          runOpenClawAgentWriteTransaction((current) => {
            executeSqliteQuerySync(
              current.db,
              getSessionKysely(current.db)
                .updateTable("session_pending_inputs")
                .set({ state: disposition })
                .where("input_id", "=", inputId)
                .where("lifecycle_generation", "=", lifecycleGeneration)
                .where("state", "=", "queued")
                .where("consumed_event_id", "is", null),
            );
          }, databaseOptions);
        },
      };
      registerSessionPendingInputOwner(owner);
      const receipt = ownerReceipt(owner, requestHash);
      if (complete) {
        receipt.complete = complete;
      }
      return receipt;
    },
    "session.pending-input.stage",
  );
}

/** Record lost custody at its read boundary without resuming a pre-restart execution. */
function readPendingInputRows(
  scope: PendingInputScope,
  options: { limit?: number; before?: number; id?: string },
): { rows: SessionPendingInputRow[]; total: number | undefined; nextBefore?: number } {
  const resolved = resolveSqliteTranscriptScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const limit = Math.max(1, Math.min(20, Math.trunc(options.limit ?? 20)));
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (!hasSessionPendingInputsSchema(database.db)) {
      return { rows: [], total: 0, staleIds: [], nextBefore: undefined };
    }
    const db = getSessionKysely(database.db);
    let base = db
      .selectFrom("session_pending_inputs")
      .where("session_key", "=", resolved.sessionKey)
      .where("session_id", "=", scope.sessionId);
    if (hasPendingInputConsumptionColumn(database.db)) {
      base = base.where("consumed_event_id", "is", null);
    }
    const total =
      options.id === undefined
        ? (executeSqliteQueryTakeFirstSync(
            database.db,
            base.select(db.fn.count<number>("input_id").as("total")),
          )?.total ?? 0)
        : undefined;
    let query = base.orderBy("seq", "desc").limit(limit + 1);
    if (options.before !== undefined) {
      query = query.where("seq", "<", options.before);
    }
    if (options.id !== undefined) {
      query = query.where("input_id", "=", options.id);
    }
    const metadata = executeSqliteQuerySync(
      database.db,
      query.select([
        "seq",
        /* kysely-allow-raw: Bound the page before fetching accepted message JSON. */
        sql<number>`OCTET_LENGTH(message_json)`.as("serialized_bytes"),
      ]),
    ).rows;
    const selected: number[] = [];
    let bytes = 0;
    for (const row of metadata) {
      if (selected.length === limit || bytes + row.serialized_bytes > MAX_PAYLOAD_BYTES) {
        break;
      }
      selected.push(row.seq);
      bytes += row.serialized_bytes;
    }
    if (metadata.length && !selected.length) {
      throw new Error("Stored pending input exceeds the Gateway payload limit");
    }
    const rows = selected.length
      ? executeSqliteQuerySync(
          database.db,
          base.selectAll().where("seq", "in", selected).orderBy("seq", "desc"),
        ).rows
      : [];
    // An aborted but registered owner still owns the terminal disposition. Reads
    // must not race its finish(cancelled) by recording an inferred interruption.
    const ownedIds = readSessionPendingInputOwnerIds(database, rows);
    const staleIds = rows
      .filter((row) => row.state === "queued" && !ownedIds.has(row.input_id))
      .map((row) => row.input_id);
    return {
      rows,
      total,
      staleIds,
      nextBefore: selected.length < metadata.length ? selected.at(-1) : undefined,
    };
  }, databaseOptions);
  if (!result.found) {
    return { rows: [], total: 0 };
  }
  const snapshot = result.value;
  if (snapshot.staleIds.length) {
    const interrupted = runOpenClawAgentWriteTransaction((database) => {
      const db = getSessionKysely(database.db);
      const candidates = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_pending_inputs")
          .select(["input_id", "session_key", "session_id", "lifecycle_generation"])
          .where("input_id", "in", snapshot.staleIds)
          .where("state", "=", "queued")
          .where("consumed_event_id", "is", null),
      ).rows;
      const ownedIds = readSessionPendingInputOwnerIds(database, candidates);
      const ids = candidates.flatMap((row) => (ownedIds.has(row.input_id) ? [] : [row.input_id]));
      if (ids.length) {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_pending_inputs")
            .set({ state: "interrupted" })
            .where("input_id", "in", ids)
            .where("consumed_event_id", "is", null),
        );
      }
      return new Set(ids);
    }, databaseOptions);
    for (const row of snapshot.rows) {
      if (interrupted.has(row.input_id)) {
        row.state = "interrupted";
      }
    }
  }
  return { rows: snapshot.rows, total: snapshot.total, nextBefore: snapshot.nextBefore };
}

export function listSessionPendingInputs(
  scope: PendingInputScope,
  options: { limit?: number; before?: number } = {},
): SessionPendingInputPage {
  const { rows, total, nextBefore } = readPendingInputRows(scope, options);
  return {
    items: rows.toReversed().map(projectSessionPendingInput),
    total: total ?? 0,
    ...(nextBefore !== undefined ? { nextBefore } : {}),
  };
}

export function readSessionPendingInput(
  scope: PendingInputScope,
  id: string,
): SessionPendingInput | undefined {
  const row = readPendingInputRows(scope, { id, limit: 1 }).rows[0];
  return row ? projectSessionPendingInput(row) : undefined;
}

/** Verify source custody before replacing a stale process-local completed receipt. */
export function claimSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): boolean {
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => claimCurrentSessionPendingInputDedupeRecovery(database, resolved, runId),
    toDatabaseOptions(resolved),
  );
  return result.found && result.value;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): PersistedUserTurnMessage | undefined {
  try {
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const db = getSessionKysely(database.db);
          const session = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("session_nodes")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_nodes.current_session_id",
              )
              .select("current_session_id")
              .where("session_nodes.session_key", "=", resolved.sessionKey)
              .where("session_windows.session_key", "=", resolved.sessionKey),
          );
          if (session?.current_session_id !== resolved.sessionId) {
            return undefined;
          }
          // Collected sources survive consumption; their text is not the aggregate transcript.
          // Check byte metadata before either reader materializes stored JSON.
          const pending = hasSessionPendingInputsSchema(database.db)
            ? executeSqliteQueryTakeFirstSync(
                database.db,
                db
                  .selectFrom("session_pending_inputs")
                  .select((eb) => eb.fn<number>("octet_length", ["message_json"]).as("bytes"))
                  .where("session_key", "=", resolved.sessionKey)
                  .where("session_id", "=", resolved.sessionId)
                  .where("idempotency_key", "=", idempotencyKey),
              )
            : undefined;
          let messageJson: string | undefined;
          if (pending) {
            if (pending.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            messageJson = readSessionPendingInputByKey(
              database,
              resolved,
              idempotencyKey,
            )?.message_json;
          } else {
            // Stale projections cannot establish retry identity. Their owning writer repairs them.
            if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
              return undefined;
            }
            const transcript = executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("transcript_event_identities as identity")
                .innerJoin("transcript_events as event", (join) =>
                  join
                    .onRef("event.session_id", "=", "identity.session_id")
                    .onRef("event.seq", "=", "identity.seq"),
                )
                .select((eb) => eb.fn<number>("octet_length", ["event.event_json"]).as("bytes"))
                .where("identity.session_id", "=", resolved.sessionId)
                .where("identity.message_idempotency_key", "=", idempotencyKey)
                .orderBy("identity.seq", "desc")
                .limit(1),
            );
            if (!transcript || transcript.bytes > MAX_PAYLOAD_BYTES) {
              return undefined;
            }
            const committed = readTranscriptMessageByScopedIdempotencyKey(
              database,
              resolved,
              idempotencyKey,
              "scan",
            );
            messageJson = committed ? JSON.stringify(committed.message) : undefined;
          }
          if (!messageJson) {
            return undefined;
          }
          const message = parseSessionPendingInputMessage(messageJson);
          return readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
        }),
      toDatabaseOptions(resolved),
    );
    return result.found ? result.value : undefined;
  } catch {
    // Unavailable or corrupt storage supplies no proof of the original submitted bytes.
    return undefined;
  }
}

/** Bounded display reconciliation; these durable correlations never authorize replay. */
export function listSessionPendingInputReceipts(
  scope: PendingInputScope,
  options: { runIds: readonly string[] },
): Array<
  | { runId: string; state: "pending" }
  | { runId: string; state: "consumed"; consumedByEventId: string }
> {
  if (options.runIds.length > 50) {
    throw new Error("Pending input receipt lookup accepts at most 50 run IDs");
  }
  const runIds = [...new Set(options.runIds)];
  if (!runIds.length) {
    return [];
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    if (
      !hasSessionPendingInputsSchema(database.db) ||
      !hasPendingInputConsumptionColumn(database.db)
    ) {
      return [];
    }
    const rows = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_pending_inputs")
        .select(["run_id", "consumed_event_id"])
        .where("session_key", "=", resolved.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where("run_id", "in", runIds)
        .orderBy("seq", "asc")
        .limit(51),
    ).rows;
    // A run ID is correlation, not unique authority. Never retire an ambiguous
    // provisional message when another source with that run is still pending.
    if (rows.length > 50 || new Set(rows.map((row) => row.run_id)).size !== rows.length) {
      throw new Error("Pending input receipt lookup has ambiguous source run IDs");
    }
    return rows.map((row) =>
      row.consumed_event_id == null
        ? { runId: row.run_id, state: "pending" as const }
        : {
            runId: row.run_id,
            state: "consumed" as const,
            consumedByEventId: row.consumed_event_id,
          },
    );
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : [];
}
