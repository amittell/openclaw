import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSilentReplyText } from "../../../auto-reply/tokens.js";
import { PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE } from "../../../infra/outbound/deliver-types.js";
import { isExecCompletionInputProvenance } from "../../../sessions/input-provenance.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { isRuntimeToolAllowed } from "../../tool-policy-match.js";
import { log } from "../logger.js";
import { SILENT_STOP_DELIVERY_RETRY_INSTRUCTION } from "./incomplete-turn-recovery.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import {
  MAX_SILENT_STOP_NUDGES,
  type EmbeddedRunTerminalRetryState,
} from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

// Fork carry: the silent-stop nudge. Under message_tool_only the model can end the turn with
// assistant text it never sent through the message tool; the payload builder suppresses that
// text, so the user gets no reply at all. One bounded continuation asks it to deliver.

/**
 * A message send that failed after it started may still have reached the user, unless the
 * platform said it never dispatched. Nudging after it could send the reply twice, so the run
 * remembers it across its retried attempts (each attempt starts with no tool error).
 */
export function recordPossiblyDeliveredMessageSend(
  retryState: EmbeddedRunTerminalRetryState,
  lastToolError: ToolErrorSummary | undefined,
): void {
  if (
    lastToolError &&
    normalizeLowercaseStringOrEmpty(lastToolError.toolName) === "message" &&
    lastToolError.executionStarted === true &&
    lastToolError.mutatingAction === true &&
    lastToolError.errorCode !== PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE
  ) {
    retryState.messageSendMayHaveLanded = true;
  }
}

/** Starts the delivery retry when this attempt owes one; true means the run retries. */
export function startSilentStopNudge(params: {
  runParams: RunEmbeddedAgentInternalParams;
  attempt: EmbeddedRunAttemptResult;
  retryState: EmbeddedRunTerminalRetryState;
  sessionPromptState: Pick<
    Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>,
    "activateInternalPrompt"
  >;
  harnessEnforcesToolPolicy: boolean;
  /** The attempt ended by abort, timeout, prompt error or a terminal tool state. */
  attemptEnded: boolean;
}): boolean {
  const { runParams, attempt, retryState } = params;
  // Key on the raw assistant text (payloads are already suppressed here), excluding an
  // intentional NO_REPLY.
  const undeliveredText = attempt.assistantTexts.some(
    (text) => text.trim().length > 0 && !isSilentReplyText(text),
  );
  // A `sessions_send` target answers its caller inline through the tool result, so its
  // text is not an undelivered user reply. An announce back to the user still is.
  const answersCallerInline =
    runParams.inputProvenance?.kind === "inter_session" &&
    runParams.inputProvenance.sourceTool === "sessions_send";
  // An exec-completion wake and a system-event turn invite NO_REPLY, so their silence is valid.
  const silenceIsValid =
    isExecCompletionInputProvenance(runParams.inputProvenance) || runParams.trigger === "event";
  // As in stranded-reply recovery, the delivery retry may call only the message tool.
  // Without a callable message tool the final text is private by design, and a harness
  // that cannot enforce the narrowed set would fail the retry, so neither is nudged.
  const messageOnlyRetryAvailable =
    params.harnessEnforcesToolPolicy &&
    (attempt.messageToolCallable ?? isRuntimeToolAllowed("message", runParams.toolsAllow));
  const deliveryGap =
    runParams.sourceReplyDeliveryMode === "message_tool_only" &&
    !answersCallerInline &&
    !silenceIsValid &&
    !retryState.messageSendMayHaveLanded &&
    undeliveredText &&
    attempt.didDeliverSourceReplyViaMessageTool !== true &&
    (attempt.messagingToolSourceReplyPayloads?.length ?? 0) === 0 &&
    !params.attemptEnded &&
    !attempt.clientToolCalls &&
    !attempt.yieldDetected &&
    messageOnlyRetryAvailable;
  if (!deliveryGap || retryState.silentStopNudges >= MAX_SILENT_STOP_NUDGES) {
    return false;
  }
  retryState.silentStopNudges += 1;
  params.sessionPromptState.activateInternalPrompt(SILENT_STOP_DELIVERY_RETRY_INSTRUCTION, {
    retryToolsAllow: ["message"],
  });
  log.warn(
    `silent-stop nudge: undelivered visible text under message_tool_only; ` +
      `retrying ${retryState.silentStopNudges}/${MAX_SILENT_STOP_NUDGES}: ` +
      `runId=${runParams.runId} sessionId=${runParams.sessionId}`,
  );
  return true;
}
