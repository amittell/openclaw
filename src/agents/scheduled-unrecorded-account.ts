import { recordModelFallbackStop } from "./model-fallback-stop.js";

/**
 * Refuses a scheduled run that records no inference account but would use a stored one.
 * The fork carry of #173411 keeps beta.4's message; upstream main's later version of this
 * module (#185070) also names the runtime, the model and the account.
 */
export function createUnrecordedScheduledAccountRefusal(): Error {
  const refusal = new Error(
    "Automation has no recorded inference account. Explicitly select its account with a model@profile update before running it.",
  );
  // Another model would only bypass the operator's account choice.
  recordModelFallbackStop(refusal);
  return refusal;
}
