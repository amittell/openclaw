import type { ProviderPromptCachePrefix } from "./provider-prompt-serialization.js";
import type { ProviderPromptState } from "./provider-prompt-state.js";

/** Most changed field names that one history or provider-prefix diagnostic lists. */
export const MAX_HISTORY_DIFF_FIELDS = 8;
// Output caps bound the completion, not the prompt that provider prefix caches key on.
// Completions routes re-clamp the cap from the remaining context budget on most requests.
const OUTPUT_CAP_PARAMETERS = new Set(["max_tokens", "max_completion_tokens", "max_output_tokens"]);

function describeProviderFields(
  before: ProviderPromptCachePrefix["parameters"],
  after: ProviderPromptCachePrefix["parameters"] | undefined,
): string {
  if (!after) {
    return "removed";
  }
  const beforeFields = before.fields ?? {};
  const afterFields = after.fields ?? {};
  const changed = [...new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])].filter(
    (key) => beforeFields[key] !== afterFields[key],
  );
  return changed.length
    ? changed.slice(0, MAX_HISTORY_DIFF_FIELDS).join("+") +
        (changed.length > MAX_HISTORY_DIFF_FIELDS ? "+remaining" : "")
    : Object.keys(beforeFields).length || Object.keys(afterFields).length
      ? "order"
      : "value";
}

function withoutOutputCaps(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => !OUTPUT_CAP_PARAMETERS.has(key)),
  );
}

function describeProviderParameters(
  beforeParameters: ProviderPromptCachePrefix["parameters"],
  afterParameters: ProviderPromptCachePrefix["parameters"],
): string | undefined {
  const beforeFields = beforeParameters.fields ?? {};
  const afterFields = afterParameters.fields ?? {};
  const before = withoutOutputCaps(beforeFields);
  const after = withoutOutputCaps(afterFields);
  const capOnly =
    [...OUTPUT_CAP_PARAMETERS].some((key) => beforeFields[key] !== afterFields[key]) &&
    Object.keys({ ...before, ...after }).every((key) => before[key] === after[key]);
  return capOnly
    ? undefined
    : `parameters:${describeProviderFields(
        { ...beforeParameters, fields: before },
        { ...afterParameters, fields: after },
      )}`;
}

export function describeProviderPrefix(
  previous: ProviderPromptState["lastAttempt"],
  next: ProviderPromptState["lastAttempt"],
): string {
  if (!previous?.cachePrefix || !next?.cachePrefix) {
    return "unavailable";
  }
  const before = previous.cachePrefix;
  const after = next.cachePrefix;
  if (previous.scopeDigest !== next.scopeDigest) {
    return "provider-scope";
  }
  const continuation = before.continuation || after.continuation;
  const segment = (["system", "tools"] as const).find((key) => before[key] !== after[key]);
  const index = before.messages.findIndex((item, i) => item.digest !== after.messages[i]?.digest);
  let prefix = segment ?? (continuation ? "wire-prefix-match" : "prefix-match");
  if (!segment && index >= 0) {
    const item = before.messages[index]!;
    const fields = item.fields ? `.${describeProviderFields(item, after.messages[index])}` : "";
    prefix = `${continuation ? "wire-input" : "message"}:${index}${fields}`;
  } else if (!segment && before.tail !== undefined) {
    // A growing tail cannot establish equality of its earlier messages from one digest.
    prefix =
      before.messageCount !== after.messageCount
        ? `unverified-after:${before.messages.length}`
        : before.tail !== after.tail
          ? `message-tail:${before.messages.length}`
          : prefix;
  }
  const parameters =
    before.parameters.digest !== after.parameters.digest
      ? describeProviderParameters(before.parameters, after.parameters)
      : undefined;
  const format = before.messageField !== after.messageField ? "input-format" : undefined;
  const details = [
    prefix.endsWith("prefix-match") && (parameters || format) ? undefined : prefix,
    format,
    parameters,
  ]
    .filter(Boolean)
    .join(",");
  // A delta request's wire input is not its logical conversation prefix.
  return `${continuation ? "continuation:" : ""}${details}`;
}
