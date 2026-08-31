/** Terminal results the embedded run loop returns when a bounded retry budget is exhausted.
 *
 * Split out of ./run-loop.ts to keep the loop within the max-lines budget. Both
 * exits are internal to the loop and no other module imported them, so nothing
 * here is re-exported from ./run-loop.ts.
 */
import type { FailoverReason } from "../embedded-agent-helpers.js";
import type { AgentRuntimeModelAttempt } from "../runtime-plan/types.js";
import { log } from "./logger.js";
import { resolveRunFailoverDecision } from "./run/failover-policy.js";
import { buildErrorAgentMeta } from "./run/helpers.js";
import type { RunEmbeddedAgentParamsWithSessionFile } from "./run/internal-params.js";
import type { RunRetryBudget } from "./run/retry-budget.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type ErrorAgentMetaInput = Parameters<typeof buildErrorAgentMeta>[0];

/**
 * Loop-owned state both exits read. Every field is reassigned across retry
 * attempts or lives behind a getter, so the loop supplies a reader rather than
 * values: reading happens at the same instant the inline code read it.
 */
export type EmbeddedRunExhaustionLoopState = {
  sessionId: ErrorAgentMetaInput["sessionId"];
  sessionFile: ErrorAgentMetaInput["sessionFile"];
  modelAttempt: AgentRuntimeModelAttempt | undefined;
  outerContextTokenMeta: { contextTokens?: number };
  usageAccumulator: ErrorAgentMetaInput["usageAccumulator"];
  lastRunPromptUsage: ErrorAgentMetaInput["lastRunPromptUsage"];
  lastProfileId: Parameters<typeof handleRetryLimitExhaustion>[0]["profileId"];
  lastRetryFailoverReason: FailoverReason | null;
  replayInvalid: boolean;
};

/** Run-scoped facts that are settled before the retry loop starts. */
export type EmbeddedRunExhaustionContext = {
  runParams: RunEmbeddedAgentParamsWithSessionFile;
  provider: string;
  modelId: string;
  reportedModelId: string;
  fallbackConfigured: boolean;
  startedAtMs: number;
  readLoopState: () => EmbeddedRunExhaustionLoopState;
};

/**
 * The retry budget is spent. Escalates to model failover when the decision says
 * so, otherwise returns a blocked retry-limit payload carrying run metadata.
 */
export function resolveEmbeddedRunRetryLimitExhaustion(
  context: EmbeddedRunExhaustionContext,
  runRetryBudget: RunRetryBudget,
): EmbeddedAgentRunResult {
  const { runParams, provider, modelId, reportedModelId, fallbackConfigured } = context;
  const state = context.readLoopState();
  const message =
    `Exceeded retry limit after ${runRetryBudget.attemptsDispatched} attempts ` +
    `(counted attempts=${runRetryBudget.attemptsCounted}, max=${runRetryBudget.maxAttempts}).`;
  log.error(
    `[run-retry-limit] sessionKey=${runParams.sessionKey ?? runParams.sessionId} ` +
      `provider=${provider}/${modelId} attempts=${runRetryBudget.attemptsDispatched} ` +
      `countedAttempts=${runRetryBudget.attemptsCounted} maxAttempts=${runRetryBudget.maxAttempts}`,
  );
  const retryLimitDecision = resolveRunFailoverDecision({
    stage: "retry_limit",
    fallbackConfigured,
    failoverReason: state.lastRetryFailoverReason,
  });
  return handleRetryLimitExhaustion({
    message,
    decision: retryLimitDecision,
    provider,
    model: modelId,
    profileId: state.lastProfileId,
    durationMs: Date.now() - context.startedAtMs,
    agentMeta: buildErrorAgentMeta({
      sessionId: state.sessionId,
      sessionFile: state.sessionFile,
      ...(state.modelAttempt ?? { provider, model: reportedModelId }),
      ...state.outerContextTokenMeta,
      usageAccumulator: state.usageAccumulator,
      lastRunPromptUsage: state.lastRunPromptUsage,
    }),
    replayInvalid: state.replayInvalid ? true : undefined,
    livenessState: "blocked",
  });
}

/**
 * The bounded same-model silent-error retries are exhausted and no model
 * fallback is configured. Terminate with a visible error payload now
 * instead of re-dispatching whole attempts until the ingress 5-min
 * adoption-stall watchdog fires (vLLM connection-churn wedge).
 */
export function buildEmbeddedRunSilentErrorExhaustedResult(
  context: EmbeddedRunExhaustionContext,
  emptyErrorRetries: number,
): EmbeddedAgentRunResult {
  const { runParams, provider, modelId, reportedModelId } = context;
  const state = context.readLoopState();
  const message =
    "The model did not produce a usable reply after several attempts. " +
    "Please try again, or use /new to start a fresh session.";
  log.error(
    "[silent-error-exhausted] sessionKey=" +
      (runParams.sessionKey ?? runParams.sessionId) +
      " provider=" +
      provider +
      "/" +
      modelId +
      " emptyErrorRetries=" +
      emptyErrorRetries +
      " - surfacing visible error payload",
  );
  return {
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: Date.now() - context.startedAtMs,
      agentMeta: buildErrorAgentMeta({
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        provider,
        model: reportedModelId,
        ...state.outerContextTokenMeta,
        usageAccumulator: state.usageAccumulator,
        lastRunPromptUsage: state.lastRunPromptUsage,
      }),
      livenessState: "blocked",
      // Terminal, not failover-coercible: a future fallback-configured caller must not silently swallow this.
      error: { kind: "silent_error_exhausted", message },
    },
  };
}
