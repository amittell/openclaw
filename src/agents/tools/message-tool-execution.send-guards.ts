/** Send-suppression steps for the message tool.
 *
 * Split out of ./message-tool-execution.ts to keep that file within the
 * max-lines budget. The tracker state stays in
 * ./message-tool-execution.send-suppression.ts; this module owns the
 * duplicate-send check made before a send and the record made after one.
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
