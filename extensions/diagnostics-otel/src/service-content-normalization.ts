import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { redactSensitiveText } from "../api.js";

export const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";
const TRUNCATED_TEXT_SUFFIX = "...(truncated)";
// Redaction runs on the event-loop thread, so its cost must follow what an attribute exports,
// not what a model call carries (megabytes of tool output or image data). Clipped text is
// redacted with this much context past its export cut: a secret that starts in the exported
// prefix and ends within the lookahead is matched as it would be in the whole text.
const OTEL_REDACTION_LOOKAHEAD_CHARS = 4096;
// Bounds the clipped text one truncated JSON candidate may send to the redactor; a candidate
// over it falls through to the next, smaller budget.
const MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR = 8;
// A private key clipped before its END line gives the PEM rule nothing to match.
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/gi;

export type OtelContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
  toolDefinitions: boolean;
  logBodies: boolean;
};

const NO_CONTENT_CAPTURE: OtelContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
  toolDefinitions: false,
  logBodies: false,
};

/** Redacts the part of `value` an export of `keepChars` can show; `clipped` means text was dropped. */
function redactExportPrefix(value: string, keepChars: number): { text: string; clipped: boolean } {
  const windowChars = keepChars + OTEL_REDACTION_LOOKAHEAD_CHARS;
  if (value.length <= windowChars) {
    return { text: redactSensitiveText(value), clipped: false };
  }
  return {
    text: omitUnterminatedPrivateKey(redactSensitiveText(truncateUtf16Safe(value, windowChars))),
    clipped: true,
  };
}

function omitUnterminatedPrivateKey(text: string): string {
  let lastEnd = 0;
  for (const end of text.matchAll(PRIVATE_KEY_END_RE)) {
    lastEnd = end.index + end[0].length;
  }
  const begin = text.slice(lastEnd).search(PRIVATE_KEY_BEGIN_RE);
  return begin < 0 ? text : text.slice(0, lastEnd + begin);
}

export function normalizeOtelLogString(value: string, maxChars: number): string {
  const { text, clipped } = redactExportPrefix(value, maxChars);
  return clipped || text.length > maxChars
    ? `${truncateUtf16Safe(text, maxChars)}${TRUNCATED_TEXT_SUFFIX}`
    : text;
}

export function normalizeOtelErrorMessage(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = normalizeOtelLogString(value.trim(), MAX_OTEL_ERROR_MESSAGE_CHARS);
  return normalized || undefined;
}

export function resolveContentCapturePolicy(value: unknown): OtelContentCapturePolicy {
  return value === true
    ? {
        inputMessages: true,
        outputMessages: true,
        toolInputs: true,
        toolOutputs: true,
        systemPrompt: false,
        toolDefinitions: true,
        logBodies: true,
      }
    : NO_CONTENT_CAPTURE;
}

export function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

export function normalizeOtelContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value.slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)) {
      if (typeof item === "string") {
        items.push(item);
      }
    }
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  const json = safeJsonString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  if (json) {
    return json;
  }
  return undefined;
}

const JSON_TRUNCATION_STRING_BUDGETS = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32] as const;
const JSON_TRUNCATION_ARRAY_ITEM_BUDGETS = [
  MAX_OTEL_CONTENT_ARRAY_ITEMS,
  100,
  50,
  25,
  10,
  5,
  1,
] as const;
const JSON_TRUNCATION_MAX_OBJECT_FIELDS = 64;
const JSON_TRUNCATION_MAX_DEPTH = 8;

type JsonTruncationOptions = {
  maxArrayItems: number;
  maxDepth: number;
  maxObjectFields: number;
  maxStringChars: number;
  seen: WeakSet<object>;
  truncateText: (value: string, maxChars: number) => string;
};

export function safeJsonString(value: unknown, maxChars: number): string | undefined {
  if (isOmittedFromJson(value)) {
    return undefined;
  }
  const unredactedExact = exceedsJsonChars(value, maxChars) ? undefined : stringifyJson(value);
  if (unredactedExact && unredactedExact.length <= maxChars) {
    const exact = stringifyJsonForOtelAttribute(value, { redactStrings: true });
    if (exact && exact.length <= maxChars) {
      return exact;
    }
  }
  // Pick the budget from unredacted sizes, then redact only the candidate that is exported.
  const maxRedactionChars = maxChars * MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR;
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      let redactionChars = 0;
      const budget = {
        maxArrayItems,
        maxDepth: JSON_TRUNCATION_MAX_DEPTH,
        maxObjectFields: JSON_TRUNCATION_MAX_OBJECT_FIELDS,
        maxStringChars,
      };
      const unredacted = stringifyJson(
        truncateJsonValueForOtelAttribute(value, {
          ...budget,
          seen: new WeakSet<object>(),
          truncateText: (text, textMaxChars) => {
            redactionChars += Math.min(text.length, textMaxChars + OTEL_REDACTION_LOOKAHEAD_CHARS);
            return text.length > textMaxChars ? clipJsonText(text, textMaxChars) : text;
          },
        }),
      );
      if (!unredacted || unredacted.length > maxChars || redactionChars > maxRedactionChars) {
        continue;
      }
      const candidate = truncateJsonValueForOtelAttribute(value, {
        ...budget,
        seen: new WeakSet<object>(),
        truncateText: truncateJsonTextForOtelAttribute,
      });
      const json = stringifyJsonForOtelAttribute(candidate);
      if (json && json.length <= maxChars) {
        return json;
      }
    }
  }
  const summary = stringifyJsonForOtelAttribute({
    truncated: true,
    reason: stringifyJson(value) ? "max_attribute_size" : "unserializable_value",
    type: describeJsonValue(value),
  });
  return summary && summary.length <= maxChars ? summary : undefined;
}

function isOmittedFromJson(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

// Lower bound on JSON.stringify(value).length, walked only until it passes maxChars: every
// emitted value takes a character and every emitted string or key appears at least once.
function exceedsJsonChars(value: unknown, maxChars: number): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let chars = 0;
  while (pending.length > 0 && chars <= maxChars) {
    const item = pending.pop();
    chars += typeof item === "string" ? item.length + 2 : 1;
    if (typeof item !== "object" || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length && chars <= maxChars; index++) {
        chars += 1;
        pending.push(item[index]);
      }
      continue;
    }
    for (const [key, field] of Object.entries(item)) {
      if (chars > maxChars) {
        break;
      }
      if (!isOmittedFromJson(field)) {
        chars += key.length + 3;
        pending.push(field);
      }
    }
  }
  return chars > maxChars;
}

function stringifyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) || undefined;
  } catch {
    return undefined;
  }
}

function redactJsonStringField(_key: string, field: unknown): unknown {
  return typeof field === "string" ? redactSensitiveText(field) : field;
}

// Strings are redacted on their own as well as inside the serialized JSON: escaping rewrites
// line breaks and quotes, which hides assignments that start a line from the text rules.
function stringifyJsonForOtelAttribute(
  value: unknown,
  options?: { redactStrings: boolean },
): string | undefined {
  try {
    const json = JSON.stringify(value, options?.redactStrings ? redactJsonStringField : undefined);
    if (!json) {
      return undefined;
    }
    return redactSensitiveText(json);
  } catch {
    return undefined;
  }
}

function truncateJsonValueForOtelAttribute(
  value: unknown,
  options: JsonTruncationOptions,
): unknown {
  if (typeof value === "string") {
    return options.truncateText(value, options.maxStringChars);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    return options.truncateText(String(value), options.maxStringChars);
  }
  if (isOmittedFromJson(value)) {
    return undefined;
  }
  if (options.maxDepth <= 0) {
    return { truncated: true, reason: "max_depth" };
  }
  if (Array.isArray(value)) {
    return truncateJsonArrayForOtelAttribute(value, options);
  }
  if (typeof value === "object") {
    return truncateJsonObjectForOtelAttribute(value as Record<string, unknown>, options);
  }
  return undefined;
}

function truncateJsonArrayForOtelAttribute(
  value: readonly unknown[],
  options: JsonTruncationOptions,
): unknown[] {
  if (options.seen.has(value)) {
    return [{ truncated: true, reason: "circular_reference" }];
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const items = value
    .slice(0, options.maxArrayItems)
    .map((item) => truncateJsonValueForOtelAttribute(item, nextOptions));
  if (value.length > items.length) {
    items.push({ truncated: true, omittedItems: value.length - items.length });
  }
  options.seen.delete(value);
  return items;
}

function truncateJsonObjectForOtelAttribute(
  value: Record<string, unknown>,
  options: JsonTruncationOptions,
): Record<string, unknown> {
  if (options.seen.has(value)) {
    return { truncated: true, reason: "circular_reference" };
  }
  options.seen.add(value);
  const nextOptions = { ...options, maxDepth: options.maxDepth - 1 };
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value).filter(([, field]) => !isOmittedFromJson(field));
  for (const [key, field] of entries.slice(0, options.maxObjectFields)) {
    result[key] = truncateJsonValueForOtelAttribute(field, nextOptions);
  }
  if (entries.length > options.maxObjectFields) {
    result.truncated = true;
    result.omittedFields = entries.length - options.maxObjectFields;
  }
  options.seen.delete(value);
  return result;
}

function clipJsonText(value: string, maxChars: number): string {
  const suffixBudget = Math.min(TRUNCATED_TEXT_SUFFIX.length, maxChars);
  const prefixBudget = Math.max(0, maxChars - suffixBudget);
  return `${truncateUtf16Safe(value, prefixBudget)}${TRUNCATED_TEXT_SUFFIX.slice(
    TRUNCATED_TEXT_SUFFIX.length - suffixBudget,
  )}`;
}

function truncateJsonTextForOtelAttribute(value: string, maxChars: number): string {
  const { text, clipped } = redactExportPrefix(value, maxChars);
  return clipped || text.length > maxChars ? clipJsonText(text, maxChars) : text;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
