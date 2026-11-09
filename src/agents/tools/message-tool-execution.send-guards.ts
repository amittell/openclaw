/** Send-suppression steps for the message tool.
 *
 * Split out of ./message-tool-execution.ts to keep that file within the
 * max-lines budget. The tracker state stays in
 * ./message-tool-execution.send-suppression.ts; this module owns the
 * pre-send checks (upstream's poll-vote echo, the fork's duplicate send) and
 * the records made after a delivered send.
 */
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { hasSendMediaPayload } from "../../infra/outbound/message-action-send-payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "../embedded-agent-helpers/messaging-dedupe.js";
import { jsonResult, readToolStringParam } from "./common.js";
import {
  DUPLICATE_SEND_MAX_TRACKED_PER_RUN,
  DUPLICATE_SEND_MIN_LENGTH_RATIO,
  DUPLICATE_SEND_TTL_MS,
  recentMessageToolSendsByRun,
} from "./message-tool-execution.send-suppression.js";
import type { VisibleTextSuppressionReason } from "./message-tool-visible-content.js";
import { recordPollVote, suppressPollVoteEcho } from "./poll-vote-echo.js";

const messageToolLog = createSubsystemLogger("message-tool");

type DuplicateSendCheck = {
  /** Set when the send repeats one already delivered in this run; return it instead of sending. */
  suppressed?: ReturnType<typeof jsonResult>;
  /** Tracks the send for its run. Call only after a non-throwing send. */
  recordDelivered: () => void;
};

/**
 * Checks a message-tool call against the sends already delivered in its run.
 * Returns undefined when the guard does not apply (no run id, no route, or not
 * a text-only send).
 */
export function checkDuplicateSend(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  runId: string | undefined,
  route: string | undefined,
): DuplicateSendCheck | undefined {
  // Strictly per-run: repeating an answer in a LATER run (user asked again)
  // is legitimate; only intra-run re-narration is the pathology.
  const duplicateSendKey = runId?.trim() || undefined;
  // Text-only guard: a media send with a repeated caption is a distinct
  // deliverable and must never be suppressed. Media detection is shared with
  // the send path so every param it delivers from also bypasses the guard.
  const duplicateSendHasMedia = hasSendMediaPayload(params);
  const duplicateSendText =
    action === "send" && !duplicateSendHasMedia
      ? (readToolStringParam(params, "text") ??
        readToolStringParam(params, "message") ??
        readToolStringParam(params, "content"))
      : undefined;
  if (!duplicateSendKey || !duplicateSendText || !route) {
    return undefined;
  }
  const recordDelivered = () => {
    const recordedAt = Date.now();
    for (const [key, entry] of recentMessageToolSendsByRun) {
      if (recordedAt - entry.recordedAt > DUPLICATE_SEND_TTL_MS) {
        recentMessageToolSendsByRun.delete(key);
      }
    }
    const entry = recentMessageToolSendsByRun.get(duplicateSendKey) ?? {
      sends: [],
      recordedAt,
    };
    entry.recordedAt = recordedAt;
    entry.sends.push({
      route,
      normalized: normalizeTextForComparison(duplicateSendText),
    });
    if (entry.sends.length > DUPLICATE_SEND_MAX_TRACKED_PER_RUN) {
      entry.sends.splice(0, entry.sends.length - DUPLICATE_SEND_MAX_TRACKED_PER_RUN);
    }
    recentMessageToolSendsByRun.set(duplicateSendKey, entry);
  };
  const tracked = recentMessageToolSendsByRun.get(duplicateSendKey);
  if (tracked && Date.now() - tracked.recordedAt <= DUPLICATE_SEND_TTL_MS) {
    const normalized = normalizeTextForComparison(duplicateSendText);
    const priorOnRoute = tracked.sends
      .filter(
        (sent) =>
          sent.route === route &&
          sent.normalized.length >= normalized.length * DUPLICATE_SEND_MIN_LENGTH_RATIO,
      )
      .map((sent) => sent.normalized);
    if (isMessagingToolDuplicateNormalized(normalized, priorOnRoute)) {
      // Observability: the suppression verdict only reaches the model;
      // this warn line is the sole operator-visible signal the guard fired.
      messageToolLog.warn(
        `duplicate_send suppressed: near-duplicate outbound message blocked for run=${duplicateSendKey}`,
      );
      return {
        suppressed: jsonResult({
          status: "suppressed",
          reason: "duplicate_send",
          message:
            "Suppressed a near-duplicate of a message already sent in this run. The earlier message was delivered; do not re-send it.",
        }),
        recordDelivered,
      };
    }
  }
  return { recordDelivered };
}

type MessageToolSendGuards = {
  /** Set when the send must not go out; return it instead of sending. */
  suppressed: ReturnType<typeof jsonResult> | undefined;
  /** Records a delivered send for both guards. Call only after a non-throwing send. */
  recordDelivered: (toolResult: { details?: unknown } | undefined) => void;
};

/**
 * Runs the message tool's pre-send guards in order: upstream's poll-vote echo
 * check, then the duplicate-send check, which is skipped when the first one
 * suppresses.
 */
export function checkMessageToolSendGuards(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  runId: string | undefined;
  route: string | undefined;
  pollEchoSessionKey: string | undefined;
  onPollVoteEchoSuppressed: () => void;
}): MessageToolSendGuards {
  const { action, args, route, pollEchoSessionKey } = params;
  const pollVoteEchoSuppressed = suppressPollVoteEcho(pollEchoSessionKey, route, action, args);
  const duplicateSend = pollVoteEchoSuppressed
    ? undefined
    : checkDuplicateSend(action, args, params.runId, route);
  const recordDelivered = (toolResult: { details?: unknown } | undefined) => {
    if (action === "poll-vote" && route && pollEchoSessionKey) {
      // SAFETY: details is provider-supplied and untyped; pollVotedOption stays unknown and is accepted only when typeof is string.
      const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
      recordPollVote(pollEchoSessionKey, route, details?.pollVotedOption);
    }
    // Record only after a non-throwing send so a failed delivery can still
    // be retried with the same text.
    duplicateSend?.recordDelivered();
  };
  if (pollVoteEchoSuppressed) {
    params.onPollVoteEchoSuppressed();
    return {
      suppressed: jsonResult({
        status: "suppressed",
        reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
        message: "Suppressed outbound text because it only restated the poll vote just cast.",
      }),
      recordDelivered,
    };
  }
  return { suppressed: duplicateSend?.suppressed, recordDelivered };
}
