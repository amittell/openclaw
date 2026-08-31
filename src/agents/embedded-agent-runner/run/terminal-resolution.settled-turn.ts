/** Settled-turn finalization request resolution for the embedded run terminal.
 *
 * Split out of ./terminal-resolution.ts to keep that module within the
 * max-lines budget. `resolveSettledTurnFinalizationRequest` is re-exported from
 * ./terminal-resolution.ts so existing import paths are unchanged.
 */
import type { EmbeddedAgentRunResult } from "../types.js";
import {
  resolveReasoningOnlyRetryInstruction,
  resolveSettledToolTerminalContinuationInstruction,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./incomplete-turn-recovery.js";
import { resolveSilentToolResultReplyPayload } from "./incomplete-turn-resolution.js";
import type { RunEmbeddedAgentInternalParams as TerminalRunParams } from "./internal-params.js";
import {
  isEmbeddedRunTerminalAbort,
  isEmbeddedRunTerminalTimeout,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

export function requiresVisibleTerminalReply(runParams: TerminalRunParams): boolean {
  return (
    runParams.terminalReplyExpectation === "required" ||
    (runParams.terminalReplyExpectation == null &&
      (runParams.trigger == null || runParams.trigger === "user" || runParams.trigger === "manual"))
  );
}

export function resolveSettledTurnFinalizationRequest(input: {
  runParams: TerminalRunParams;
  attempt: EmbeddedRunAttemptResult;
  activeErrorContext: { provider: string; model: string };
  modelApi: Parameters<typeof resolveReasoningOnlyRetryInstruction>[0]["modelApi"];
  executionContract: Parameters<
    typeof resolveReasoningOnlyRetryInstruction
  >[0]["executionContract"];
  payloadsWithToolMedia: EmbeddedAgentRunResult["payloads"];
  recoveredFinalAssistantPayloadsAfterPromptTimeout?: EmbeddedAgentRunResult["payloads"];
  hasTerminalToolPresentation: boolean;
  terminalState: EmbeddedRunTerminalState;
  settledTurnFinalizationAvailable: boolean;
}): string | null {
  if (!input.settledTurnFinalizationAvailable) {
    return null;
  }
  const terminalAborted = isEmbeddedRunTerminalAbort(input.terminalState.outcome);
  const terminalTimedOut = isEmbeddedRunTerminalTimeout(input.terminalState.outcome);
  const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
    isCronTrigger: input.runParams.trigger === "cron",
    payloadCount: input.payloadsWithToolMedia?.length ?? 0,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  const terminalAssistant = input.attempt.currentAttemptAssistant ?? input.attempt.lastAssistant;
  // Payload preparation renders an undelivered tool-error fallback before the
  // model gets its final answer. It must not masquerade as an assistant reply;
  // exact failed-call settlement is independently proven by the finalizer owner.
  const hasOnlySyntheticToolErrorPayload = Boolean(
    terminalAssistant?.stopReason === "toolUse" &&
    input.attempt.lastToolError &&
    input.attempt.assistantTexts.every((text) => text.trim().length === 0) &&
    (input.payloadsWithToolMedia?.length ?? 0) > 0 &&
    input.payloadsWithToolMedia?.every(
      (payload) =>
        payload.isError === true &&
        Object.keys(payload).every((key) => key === "text" || key === "isError"),
    ),
  );
  const payloadCount = input.recoveredFinalAssistantPayloadsAfterPromptTimeout
    ? input.recoveredFinalAssistantPayloadsAfterPromptTimeout.length
    : hasOnlySyntheticToolErrorPayload
      ? 0
      : input.payloadsWithToolMedia?.length
        ? input.payloadsWithToolMedia.length
        : silentToolResultReplyPayload
          ? 1
          : 0;
  const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
    allowEmptyAssistantReplyAsSilent: input.runParams.allowEmptyAssistantReplyAsSilent,
    terminalReplyExpectation: input.runParams.terminalReplyExpectation,
    onlyExplicitSilentReply: false,
    payloadCount,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
  if (emptyAssistantReplyIsSilent) {
    return null;
  }
  return resolveSettledToolTerminalContinuationInstruction({
    provider: input.activeErrorContext.provider,
    modelId: input.activeErrorContext.model,
    modelApi: input.modelApi,
    executionContract: input.executionContract,
    allowEmptyStopContinuation: requiresVisibleTerminalReply(input.runParams),
    payloadCount,
    hasTerminalToolPresentation: input.hasTerminalToolPresentation,
    aborted: terminalAborted,
    timedOut: terminalTimedOut,
    attempt: input.attempt,
  });
}
