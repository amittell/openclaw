import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "./restart-recovery-state.js";
import {
  preparePendingInputMessage,
  preparePendingInputRequest,
  resolveCommittedPendingInputRequestHash,
  resolvePendingInputReplayRequest,
  matchesSessionPendingInputRequest,
  type PendingInputRequest,
} from "./session-accessor.pending-input-request.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import {
  prepareCurrentSessionPendingInputDedupeRecovery,
  isFinalInputCompletion,
  parseSessionPendingInputMessage,
  hasRegisteredSessionPendingInputOwner,
  registerSessionPendingInputOwner,
  releaseSessionPendingInputOwner,
  assertRegisteredSessionPendingInputOwner,
  assertSessionPendingInputLifetimeCurrent,
  runWithSessionPendingInput,
  runWithSessionPendingInputPersistence,
  withSessionPendingInputRelocation,
  type SessionPendingInput,
  type SessionPendingInputOwner,
  type SessionPendingInputPage,
} from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteSessionKey,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { redactTranscriptMessageForStorage } from "./session-accessor.sqlite-transcript-store.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import {
  withCurrentPendingInputAuthority,
  type SessionPendingInputAuthority,
} from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type { PendingInputCustodyGrant } from "./session-pending-input-operations.types.js";
import type { SessionPendingInputReceipt } from "./session-pending-input-receipt.types.js";
import { readPendingInputSource } from "./session-pending-input-source.js";
import { preparePendingInputStore, type PendingInputScope } from "./session-pending-input-store.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export { withSessionPendingInputRelocation };
export type { SessionPendingInput, SessionPendingInputPage };
export type { SessionPendingInputReceipt } from "./session-pending-input-receipt.types.js";

const receiptOwners = new WeakMap<SessionPendingInputReceipt, SessionPendingInputOwner>();
const withdrawnOwners = new WeakSet<SessionPendingInputOwner>();

export function readWithdrawnSessionPendingInputId(
  receipt: SessionPendingInputReceipt | undefined,
): string | undefined {
  const owner = receipt && receiptOwners.get(receipt);
  return owner && withdrawnOwners.has(owner) ? owner.inputId : undefined;
}

function ownerReceipt(
  owner: SessionPendingInputOwner,
  requestHash?: string,
): SessionPendingInputReceipt {
  const receipt: SessionPendingInputReceipt = {
    get state() {
      return owner.consumed || owner.sources?.every((source) => source.consumed)
        ? "consumed"
        : "queued";
    },
    inputId: owner.inputId,
    ...(requestHash ? { requestHash } : {}),
    message: parseSessionPendingInputMessage(owner.messageJson),
    run: (operation) => runWithSessionPendingInput(owner, operation),
    runAsync: (operation) =>
      withCurrentPendingInputAuthority(
        (owner.sources ?? [owner]).flatMap((source) =>
          source.authority ? [source.authority] : [],
        ),
        () => assertSessionPendingInputLifetimeCurrent(owner),
        () => runWithSessionPendingInput(owner, operation),
      ),
    assertLifetimeCurrent: () => assertSessionPendingInputLifetimeCurrent(owner),
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
        source.workerDatabasePath !== first.workerDatabasePath ||
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
  const aggregate = ownerReceipt({
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
  aggregate.settled = async () => {
    const results = await Promise.allSettled(receipts.map(async (receipt) => receipt.settled?.()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length) {
      throw new AggregateError(failures, "Failed to settle collected input custody");
    }
  };
  return aggregate;
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
  return preparePendingInputMessage(message, requestFingerprint).requestHash;
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

/**
 * The session row the committed-turn terminal test reads after the stage snapshot. A captured
 * incognito actor owns its namespace, so its row is read through that actor; the host must not
 * open the private database itself.
 */
async function readCommittedTurnSessionEntry(
  scope: PendingInputScope,
  sessionKey: string,
  assertCurrent: () => void,
): Promise<SessionEntry | undefined> {
  const incognito = scope.incognito;
  if (!incognito) {
    return loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
  }
  const read = await incognito.actor.sessions.read(
    {
      assertCurrent: () => {
        assertCurrent();
        incognito.authority.assertCurrent();
      },
    },
    { sessionKey },
    incognito.admissionSignal,
  );
  read.snapshot.assertCurrent();
  return read.entry;
}

type PendingInputStageOptions = PendingInputRequest & {
  authority?: SessionPendingInputAuthority;
  trackCompletion?: boolean;
  assertCurrent: () => void;
  assertAdmittedCurrent?: () => void;
  assertCompletionCurrent?: () => void;
};

/** Accept durable input without changing the active transcript or scheduling execution. */
export function stageSessionPendingInput(
  scope: PendingInputScope,
  options: PendingInputStageOptions,
): Promise<SessionPendingInputReceipt | undefined> {
  const incognito = scope.incognito ?? captureIncognitoSessionOperation(scope);
  incognito?.admissionSignal?.throwIfAborted();
  incognito?.actor.assertCurrent();
  const captured = {
    ...scope,
    incognito: incognito && { ...incognito },
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const preparedRequest = preparePendingInputRequest(options);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const admission = resolveSqliteWriteAdmissionScope(captured);
  const stage = async () => {
    const store = await preparePendingInputStore(
      captured,
      options.authority?.assertLifetimeCurrent ?? options.assertCurrent,
    );
    return store.withAdmission(
      () =>
        stagePreparedPendingInput(captured, options, preparedRequest, lifecycleGeneration, store),
      admission !== undefined,
    );
  };
  return admission ? runOpenClawAgentWriteAdmission(toDatabaseOptions(admission), stage) : stage();
}

async function stagePreparedPendingInput(
  scope: PendingInputScope,
  options: PendingInputStageOptions,
  preparedRequest: ReturnType<typeof preparePendingInputRequest>,
  lifecycleGeneration: string,
  store: Awaited<ReturnType<typeof preparePendingInputStore>>,
): Promise<SessionPendingInputReceipt | undefined> {
  let retained = false;
  let finished = false;
  let owner: SessionPendingInputOwner | undefined;
  let completion: Promise<AgentRunTerminalOutcome> | undefined;
  const assertPrepared = (
    facts: PendingInputCustodyGrant | undefined,
    guard: () => void,
    assertSourceCurrent = store.assertCurrent,
  ) => {
    if (options.authority) {
      if (!facts?.authority) {
        throw new Error("Pending input grant omitted its current session authority");
      }
      return options.authority.withPreparedCurrent(facts.authority, guard, assertSourceCurrent);
    }
    return guard();
  };
  const assertCurrent = () =>
    options.authority
      ? options.authority.withCurrent(() => options.assertCurrent())
      : options.assertCurrent();
  try {
    const identity = {
      sessionKey: store.sessionKey,
      sessionId: scope.sessionId,
      idempotencyKey: preparedRequest.idempotencyKey,
    };
    const snapshot = await store.read({
      ...identity,
      kind: "stage",
      trackCompletion: options.trackCompletion === true,
    });
    if (snapshot.kind !== "stage") {
      throw new Error("Pending input read returned a different operation");
    }
    await assertCurrent();
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    if (!snapshot.current) {
      return undefined;
    }
    const { existing, previous, committed } = snapshot;
    const replayRequest = resolvePendingInputReplayRequest(preparedRequest, previous ?? existing);
    const { message, stableMessage } = replayRequest;
    let requestHash = replayRequest.requestHash;
    if (previous && (previous.request_hash !== requestHash || previous.run_id !== options.runId)) {
      throw new Error("Input completion idempotency key conflicts with the accepted input");
    }
    if (previous && isFinalInputCompletion(previous.outcome)) {
      return {
        state: "consumed",
        inputId: identity.idempotencyKey,
        message,
        completion: previous.outcome,
        run: () => {
          throw new Error("Input processing has already completed");
        },
        finish: () => {},
      };
    }
    const assertUnowned = (row = existing) => {
      if (row && hasRegisteredSessionPendingInputOwner(store.workerDatabasePath, row)) {
        throw new SessionPendingInputCustodyError(
          "Pending input is already admitted; wait for its current turn",
        );
      }
    };
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
      assertUnowned();
      if (
        (!options.requestFingerprint && !options.trackCompletion) ||
        (existing.state !== "queued" && existing.state !== "interrupted") ||
        (existing.lifecycle_generation === lifecycleGeneration && !options.trackCompletion)
      ) {
        throw new Error("Pending input ownership ended; submit a new turn to continue");
      }
    }
    const settlementIdentity = () => ({
      ...identity,
      runId: options.runId,
      requestHash,
      lifecycleGeneration,
      ...(options.authority ? { authorityAgentId: scope.agentId } : {}),
    });
    const assertCompletion = () => {
      (options.assertCompletionCurrent ?? options.assertCurrent)();
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      if (owner) {
        assertRegisteredSessionPendingInputOwner(owner);
      }
    };
    const completionInput = (outcome: AgentRunTerminalOutcome) => ({
      ...settlementIdentity(),
      kind: "complete" as const,
      outcome,
    });
    const complete = options.trackCompletion
      ? (outcome: AgentRunTerminalOutcome) => {
          if (finished || completion) {
            throw new Error("Input completion owner has already been released or is settling");
          }
          assertCompletion();
          return store.nativeMutation(completionInput(outcome), assertCompletion).outcome!;
        }
      : undefined;
    const completeAsync = options.trackCompletion
      ? (outcome: AgentRunTerminalOutcome) => {
          if (completion) {
            return completion;
          }
          if (finished) {
            return Promise.reject(new Error("Input completion owner has already been released"));
          }
          (options.authority?.assertLifetimeCurrent ?? assertCompletion)();
          completion = store
            .mutate(completionInput(outcome), (_stage, facts) =>
              assertPrepared(facts, assertCompletion),
            )
            .then((receipt) => {
              if (!receipt.outcome) {
                throw new Error("Input completion omitted its committed outcome");
              }
              return receipt.outcome;
            });
          return completion;
        }
      : undefined;
    const finish = (disposition: "cancelled" | "interrupted") => {
      if (finished) {
        return;
      }
      finished = true;
      if (owner) {
        owner.settling = true;
      }
      // Prompt authority ends now; history custody lasts through terminal settlement.
      const settleDisposition = async () => {
        if (owner && !owner.consumed) {
          const receipt = await store.mutate(
            { ...settlementIdentity(), kind: "finish", inputId: owner.inputId, disposition },
            () => assertRegisteredSessionPendingInputOwner(owner!),
          );
          if (receipt.withdrawnInputId === owner.inputId) {
            withdrawnOwners.add(owner);
          }
        }
      };
      const ending = completion
        ? completion
            .catch((error: unknown) => {
              rethrowIncognitoSessionError(error);
              if (hasSqliteWorkerOutcomeUnknown(error)) {
                throw error;
              }
            })
            .then(settleDisposition)
        : settleDisposition();
      store.retire(
        ending.then(
          () => {
            if (owner) {
              releaseSessionPendingInputOwner(owner);
            }
          },
          (error: unknown) => {
            if (owner && !hasSqliteWorkerOutcomeUnknown(error)) {
              releaseSessionPendingInputOwner(owner);
            }
            throw error;
          },
        ),
      );
    };
    store.bindCustody(() => {
      finished = true;
      if (owner) {
        releaseSessionPendingInputOwner(owner);
      }
    });
    const completionMethods = {
      ...(complete ? { complete, completeAsync } : {}),
      settled: store.settled,
    };
    if (committed) {
      if (options.trackCompletion) {
        const committedHash = resolveCommittedPendingInputRequestHash(
          {
            ...options,
            message,
            replaySourceSessionKeys:
              previous || existing ? undefined : options.replaySourceSessionKeys,
          },
          committed.message,
        );
        if (!committedHash) {
          return undefined;
        }
        requestHash = committedHash;
        await assertCurrent();
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
      const idempotencyKey = identity.idempotencyKey;
      const channelBoundKey = idempotencyKey.startsWith(CHANNEL_USER_KEY_PREFIX);
      // v2026.10.1 builds the stage snapshot in the pending-input kernel (worker or native)
      // and reports only whether the session row is current; the restart-recovery claim and
      // the answered-turn marker live on that row, so the terminal test reads it here, AFTER
      // the snapshot. trackCompletion retries are always admitted below and never need it.
      const sessionEntry = options.trackCompletion
        ? undefined
        : await readCommittedTurnSessionEntry(scope, store.sessionKey, store.assertCurrent);
      // A row that no longer names this session rotated after the snapshot, by a writer outside
      // this admission (another process). Deciding on its absent evidence re-ran answered
      // turns and consumed owed re-drives; like 9.9's single read, it is no longer current.
      if (!options.trackCompletion && sessionEntry?.sessionId !== scope.sessionId) {
        return undefined;
      }
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
        typeof committed.message.timestamp === "number" ? committed.message.timestamp : 0;
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
      if (
        !options.trackCompletion &&
        !requiresRecoveryRedelivery &&
        (channelBoundKey || answeredAlready)
      ) {
        // Terminal receipts hold no store custody, like the consumed returns above, so the
        // store is released on the way out instead of waiting for a finish that may not come.
        return {
          state: "consumed",
          inputId: committed.messageId,
          requestHash,
          message: committed.message,
          run: (operation) => {
            options.assertCurrent();
            return operation();
          },
          finish: () => {},
        };
      }
      retained = true;
      const run = <T>(operation: () => T) => {
        store.assertCurrent();
        if (finished) {
          throw new SessionPendingInputCustodyError("Pending input ownership ended");
        }
        scope.incognito?.authority.assertCurrent();
        options.assertCurrent();
        return operation();
      };
      return {
        state: "queued",
        inputId: committed.messageId,
        requestHash,
        message: committed.message,
        run,
        assertLifetimeCurrent: () => {
          store.assertCurrent();
          (options.authority?.assertLifetimeCurrent ?? options.assertCurrent)();
        },
        runAsync: <T>(operation: () => T): Promise<Awaited<T>> =>
          withCurrentPendingInputAuthority(
            options.authority ? [options.authority] : [],
            () => {
              store.assertCurrent();
              options.authority?.assertLifetimeCurrent();
            },
            () => run(operation),
          ),
        finish,
        ...completionMethods,
      };
    }
    const prepareMessage = () => {
      options.assertCurrent();
      return options.prepareMessageAfterIdempotencyCheck!(message);
    };
    const prepared = existing
      ? parseSessionPendingInputMessage(existing.message_json)
      : options.prepareMessageAfterIdempotencyCheck
        ? options.authority
          ? await options.authority.withCurrent(prepareMessage)
          : prepareMessage()
        : message;
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
    const assertAdmittedCurrent = options.assertAdmittedCurrent ?? options.assertCurrent;
    owner = {
      agentId: scope.agentId,
      databaseAgentId: store.databaseAgentId,
      inputId,
      transcriptInputId: inputId,
      sessionId: scope.sessionId,
      sessionKey: store.sessionKey,
      databasePath: store.path,
      workerDatabasePath: store.workerDatabasePath,
      idempotencyKey: identity.idempotencyKey,
      lifecycleGeneration,
      messageJson,
      config: options.config,
      assertCurrent: () => {
        store.assertCurrent();
        scope.incognito?.actor.assertCurrent();
        scope.incognito?.authority.assertCurrent();
        assertAdmittedCurrent();
      },
      authority: options.authority,
      ...(existing ? { restartRecovered: true as const } : {}),
      finish,
    };
    await store.mutate(
      {
        ...settlementIdentity(),
        kind: "stage",
        expected: snapshot,
        trackCompletion: options.trackCompletion === true,
        inputId,
        messageJson,
      },
      (_stage, facts) => {
        assertPrepared(facts, () => {
          options.assertCurrent();
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          assertUnowned(facts?.candidate);
        });
      },
      (facts, assertSourceCurrent) => {
        assertPrepared(
          facts,
          () => {
            options.assertCurrent();
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            registerSessionPendingInputOwner(owner!);
          },
          assertSourceCurrent,
        );
      },
    );
    retained = true;
    return Object.assign(ownerReceipt(owner, requestHash), completionMethods);
  } finally {
    if (!retained) {
      await store.release();
    }
  }
}

export {
  listSessionPendingInputs,
  readSessionPendingInput,
} from "./session-pending-input-history.js";

/** Prepare evidence; only the later synchronous claim may spend recovered host custody. */
export async function prepareSessionPendingInputDedupeRecovery(
  scope: PendingInputScope,
  runId: string,
): Promise<(() => boolean) | undefined> {
  const claim = prepareCurrentSessionPendingInputDedupeRecovery(
    { ...scope, sessionKey: resolveSqliteSessionKey(scope.sessionKey, scope.agentId) },
    runId,
  );
  if (!claim) {
    return undefined;
  }
  const source = await readPendingInputSource(scope, `${runId}:user`, true);
  return source
    ? () => {
        source.assertCurrent();
        return claim(source.path, source.snapshot);
      }
    : undefined;
}

/** Read one admitted source for explicit retry comparison; this never authorizes replay. */
export async function readSessionSubmittedInput(
  scope: PendingInputScope,
  idempotencyKey: string,
): Promise<PersistedUserTurnMessage | undefined> {
  const source = await readPendingInputSource(scope, idempotencyKey, false);
  if (!source?.snapshot.current) {
    return undefined;
  }
  source.assertCurrent();
  const { pending, committed } = source.snapshot;
  const message = pending ? parseSessionPendingInputMessage(pending.message_json) : committed;
  return message && readMessageIdempotencyKey(message) === idempotencyKey ? message : undefined;
}
