/** Model-fallback attribution for one isolated cron prompt attempt.
 *
 * Split out of ./run-executor.ts to keep that module within the max-lines
 * budget.
 */
import type { CronCompletedPromptRun } from "./run.types.js";

type CronModelTuple = { provider: string; model: string };

type CronFallbackAttribution = Pick<
  CronCompletedPromptRun,
  "requestedProvider" | "requestedModel" | "usedFallback"
>;

/**
 * Captures the provider/model tuple THIS attempt requested; the returned function
 * attributes the tuple that answered. Capture at the top of the attempt, before
 * the served tuple is written back to the live selection.
 */
export function captureCronFallbackAttribution(
  requested: CronModelTuple,
): (served: CronModelTuple) => CronFallbackAttribution {
  const requestedProvider = requested.provider;
  const requestedModel = requested.model;
  // A fallback served this run only if the tuple that answered differs from the
  // one THIS attempt requested. The requested tuple is read from liveSelection at
  // the top of the runPrompt call, so a deliberate live model switch (which
  // re-enters runPrompt) compares equal and is correctly NOT a fallback, while a
  // genuine fallback compares unequal. Do not compare against liveSelection after
  // the attempt: by then it has already been rewritten to the served tuple.
  return (served) => ({
    requestedProvider,
    requestedModel,
    usedFallback: served.provider !== requestedProvider || served.model !== requestedModel,
  });
}
