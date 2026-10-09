import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  getLongestRegisteredSecretLength,
  hasConfiguredRedactPatterns,
  redactSensitiveText,
} from "../api.js";

const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
export const MAX_OTEL_CONTENT_ARRAY_ITEMS = 200;
const MAX_OTEL_ERROR_MESSAGE_CHARS = 4 * 1024;
const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";
const TRUNCATED_TEXT_SUFFIX = "...(truncated)";
// Redaction runs on the event-loop thread, so its cost must follow what an attribute exports,
// not what a model call carries (megabytes of tool output or image data). Clipped text is
// redacted with at least this much context past its export cut: a secret that starts in the
// exported prefix and ends within the lookahead is matched as it would be in the whole text.
const MIN_OTEL_REDACTION_LOOKAHEAD_CHARS = 4096;
// Bounds the clipped text one truncated JSON candidate may send to the redactor, counted as one
// window per clipped string; a candidate over it falls through to the next, smaller budget.
// Masks and quote probes can make a clipped string cost up to five windows.
const MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR = 8;
// Some secrets end with a part the window can cut off: a private key's END line, the closing
// quote of a quoted value (JSON secret keys, quoted assignments, CLI flags), a JWT's signature,
// or the `@` after a URL password. A secret the window leaves open is masked from where its value
// starts.
const OPEN_SECRET_MASK = "***";
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const PRIVATE_KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/gi;
// The redactor's JWT rule needs all three base64url segments. A run of base64url characters and
// dots that reaches the window end can hold a JWT cut before its signature: a header of at least
// the rule's length, starting `eyJ`, then a dot. It is masked from where that header starts. A
// header that alone runs past the window is not recognized; it holds JOSE parameters, not claims
// or the signature.
const JWT_HEADER_PREFIX = "eyJ";
const JWT_MIN_HEADER_CHARS = 13;
// The redactor's URL password rules end at the `@` after the userinfo. A password that runs to the
// window end, with no character in between that ends one, is masked from its start. The prefix
// takes the rules' schemes and userinfo; a scheme starts at most 16 characters before the userinfo.
// A raw `/` ends the password even for database URLs, whose rule allows one: userinfo cannot hold
// a raw `/` (RFC 3986), and a credential-free URL's port and path would otherwise read as an open
// password. A port followed by a run without `/`, whitespace or `@` that reaches the window end
// still does, and is dropped from the port.
const OPEN_URL_PASSWORD_PREFIX_RE =
  /\b(?:https?|wss?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^/\s:@]*:/gi;
const URL_PASSWORD_END_CHAR_RE = /[/\s@]/;
const OPEN_URL_SCHEME_MAX_CHARS = 16;
// Whether a quote opens a secret is asked of the redactor: it gets the key before the quote, the
// separator and quote, then a stand-in value and the closing quote. Each probe stays under
// 512 characters: separator whitespace collapses to one space, as the rules' `\s*` allows, and
// escapes are capped at the redactor's own limit for serialized quotes.
const OPEN_QUOTE_PROBE_CONTEXT_CHARS = 256;
const OPEN_QUOTE_PROBE_SEPARATOR_CHARS = 16;
const OPEN_QUOTE_PROBE_ESCAPE_CHARS = 64;
const OPEN_QUOTE_PROBE_VALUE = "0".repeat(24);
const OPEN_QUOTE_SEPARATOR_CHAR_RE = /[\s:=]/;
const NON_WORD_CHAR_RE = /\W/;

// Registered secrets only match whole, so the lookahead also covers the longest registered surface
// form (URL-encoded and JSON-escaped forms included). That length widens every clipped string's
// window, so redaction work grows linearly with it. JSON attributes count the wider windows against
// their 8x cap and keep fewer items as it grows; once a single clipped string's window passes the
// cap (a surface form of about 1M characters), they export only the truncation summary.
// Configured `logging.redactPatterns` can need any amount of text past a cut, so with them the
// lookahead is unbounded: every string is redacted whole, without the cap, as main does.
function otelRedactionLookaheadChars(): number {
  if (hasConfiguredRedactPatterns()) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(MIN_OTEL_REDACTION_LOOKAHEAD_CHARS, getLongestRegisteredSecretLength());
}

/** Redacts the part of `value` an export of `keepChars` can show; `clipped` means text was dropped. */
function redactExportPrefix(value: string, keepChars: number): { text: string; clipped: boolean } {
  const lookaheadChars = otelRedactionLookaheadChars();
  const neededChars = keepChars + lookaheadChars;
  let redacted = redactWindow(value, neededChars);
  // Masks shorten text, so the export cut can move into the lookahead, where a secret the window
  // cuts off may start. Twice the shortfall restores the lookahead when masks shortened at most
  // half the text. With the first window, redaction work stays within four windows plus probes.
  if (!redacted.settled && redacted.text.length < neededChars) {
    redacted = redactWindow(value, neededChars + 2 * (neededChars - redacted.text.length));
  }
  if (redacted.settled || redacted.text.length >= neededChars) {
    return redacted;
  }
  // Masks only shorten text (values under three characters aside), so keeping a lookahead of
  // redacted text after the export keeps at least that much input after it.
  const exportChars = redacted.text.length - lookaheadChars;
  return { text: truncateUtf16Safe(redacted.text, Math.max(0, exportChars)), clipped: true };
}

/** `settled` means nothing past the window can change the redacted text. */
function redactWindow(
  value: string,
  windowChars: number,
): { text: string; clipped: boolean; settled: boolean } {
  if (value.length <= windowChars) {
    return { text: redactSensitiveText(value), clipped: false, settled: true };
  }
  const clippedText = truncateUtf16Safe(value, windowChars);
  const openSecret = findOpenSecret(clippedText);
  if (!openSecret) {
    return { text: redactSensitiveText(clippedText), clipped: true, settled: false };
  }
  const beforeSecret = redactSensitiveText(clippedText.slice(0, openSecret.start));
  return {
    text: `${beforeSecret}${OPEN_SECRET_MASK}${openSecret.closing}`,
    clipped: true,
    settled: true,
  };
}

/** A secret whose closing delimiter lies past the end of `text`, masked from `start`. */
function findOpenSecret(text: string): { start: number; closing: string } | undefined {
  let lastEnd = 0;
  for (const end of text.matchAll(PRIVATE_KEY_END_RE)) {
    lastEnd = end.index + end[0].length;
  }
  const begin = text.slice(lastEnd).search(PRIVATE_KEY_BEGIN_RE);
  let open = begin < 0 ? undefined : { start: lastEnd + begin, closing: "" };
  const jwtStart = findOpenJwt(text);
  if (jwtStart !== undefined && jwtStart < (open?.start ?? text.length)) {
    open = { start: jwtStart, closing: "" };
  }
  const passwordStart = findOpenUrlPassword(text);
  if (passwordStart !== undefined && passwordStart < (open?.start ?? text.length)) {
    open = { start: passwordStart, closing: "" };
  }
  // An open quoted value holds no closing quote, so it follows the last quote of its kind. A
  // quote before the last line break is probed with a value that crosses a line, which only
  // rules for values spanning lines (JSON strings) mask.
  const lineStart = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r")) + 1;
  for (const quote of ['"', "'", "`"]) {
    const quoteIndex = text.lastIndexOf(quote);
    if (quoteIndex < 0 || quoteIndex + 1 >= (open?.start ?? text.length)) {
      continue;
    }
    // An escaped quote closes with the same escape.
    let escapeStart = quoteIndex;
    while (escapeStart > 0 && text[escapeStart - 1] === "\\") {
      escapeStart--;
    }
    let separatorStart = escapeStart;
    while (
      separatorStart > 0 &&
      OPEN_QUOTE_SEPARATOR_CHAR_RE.test(text[separatorStart - 1] ?? "")
    ) {
      separatorStart--;
    }
    const escapes = Math.min(quoteIndex - escapeStart, OPEN_QUOTE_PROBE_ESCAPE_CHARS);
    const closing = `${"\\".repeat(escapes)}${quote}`;
    const separator = text
      .slice(separatorStart, escapeStart)
      .replace(/\s+/g, " ")
      .slice(-OPEN_QUOTE_PROBE_SEPARATOR_CHARS);
    // Start the key context on a non-word character, so the probe's start adds no word boundary
    // the text lacks: a rule anchored there could take this quote as its closing one. A context
    // that is one word throughout keeps its cut.
    let keyStart = Math.max(0, separatorStart - OPEN_QUOTE_PROBE_CONTEXT_CHARS);
    if (keyStart > 0) {
      const wordEnd = text.slice(keyStart - 1, separatorStart).search(NON_WORD_CHAR_RE);
      keyStart += wordEnd < 0 ? 0 : wordEnd - 1;
    }
    const key = text.slice(keyStart, separatorStart);
    const value = `${quoteIndex < lineStart ? "\n" : ""}${OPEN_QUOTE_PROBE_VALUE}${closing}`;
    // Only the stand-in's own position counts: the key context may hold the same characters.
    if (!redactSensitiveText(`${key}${separator}${closing}${value}`).endsWith(value)) {
      open = { start: quoteIndex + 1, closing };
    }
  }
  return open;
}

/** Where a JWT starts in the base64url run that ends `text`, if the run holds one. */
function findOpenJwt(text: string): number | undefined {
  let from = text.length;
  while (from > 0 && isJwtChar(text.charCodeAt(from - 1))) {
    from--;
  }
  // Each candidate header ends at the next dot; a shorter one than the rule's is not a header.
  for (;;) {
    const start = text.indexOf(JWT_HEADER_PREFIX, from);
    const headerEnd = start < 0 ? -1 : text.indexOf(".", start);
    if (headerEnd < 0) {
      return undefined;
    }
    if (headerEnd - start >= JWT_MIN_HEADER_CHARS) {
      return start;
    }
    from = headerEnd + 1;
  }
}

/** Where a URL password starts when the `@` that ends it lies past the end of `text`. */
function findOpenUrlPassword(text: string): number | undefined {
  let runStart = text.length;
  while (runStart > 0 && !URL_PASSWORD_END_CHAR_RE.test(text[runStart - 1] ?? "")) {
    runStart--;
  }
  // The scheme and `//` end before the run that ends `text`; the userinfo and password are in it.
  OPEN_URL_PASSWORD_PREFIX_RE.lastIndex = Math.max(0, runStart - OPEN_URL_SCHEME_MAX_CHARS);
  for (
    let match = OPEN_URL_PASSWORD_PREFIX_RE.exec(text);
    match && match.index < runStart;
    match = OPEN_URL_PASSWORD_PREFIX_RE.exec(text)
  ) {
    const passwordStart = match.index + match[0].length;
    if (passwordStart > runStart && passwordStart < text.length) {
      return passwordStart;
    }
  }
  return undefined;
}

/** Base64url characters and the dots between JWT segments. */
function isJwtChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x2e ||
    code === 0x5f
  );
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

export function hasPreloadedOtelSdk(): boolean {
  return process.env[PRELOADED_OTEL_SDK_ENV] === "1";
}

export function normalizeOtelContentValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeOtelLogString(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_OTEL_CONTENT_ARRAY_ITEMS)
      .filter((item): item is string => typeof item === "string");
    if (items.length > 0) {
      return normalizeOtelLogString(items.join("\n"), MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
  }
  return safeJsonString(value);
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

export function safeJsonString(value: unknown): string | undefined {
  if (isOmittedFromJson(value)) {
    return undefined;
  }
  const unredactedExact = exceedsJsonChars(value, MAX_OTEL_CONTENT_ATTRIBUTE_CHARS)
    ? undefined
    : stringifyJson(value);
  if (unredactedExact && unredactedExact.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
    const exact = stringifyJsonForOtelAttribute(value, { redactStrings: true });
    if (exact && exact.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
      return exact;
    }
  }
  // Pick the budget from unredacted sizes, then redact only the candidate that is exported.
  const lookaheadChars = otelRedactionLookaheadChars();
  const maxRedactionChars = Number.isFinite(lookaheadChars)
    ? MAX_OTEL_CONTENT_ATTRIBUTE_CHARS * MAX_OTEL_JSON_REDACTION_CHARS_PER_EXPORT_CHAR
    : Number.POSITIVE_INFINITY;
  let redactionCapped = false;
  for (const maxArrayItems of JSON_TRUNCATION_ARRAY_ITEM_BUDGETS) {
    for (const maxStringChars of JSON_TRUNCATION_STRING_BUDGETS) {
      let redactionChars = 0;
      const unredacted = stringifyJson(
        truncateJsonValueForOtelAttribute(value, maxArrayItems, (text) => {
          redactionChars += Math.min(text.length, maxStringChars + lookaheadChars);
          return text.length > maxStringChars ? clipJsonText(text, maxStringChars) : text;
        }),
      );
      if (!unredacted || unredacted.length > MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
        continue;
      }
      if (redactionChars > maxRedactionChars) {
        redactionCapped = true;
        continue;
      }
      const candidate = truncateJsonValueForOtelAttribute(value, maxArrayItems, (text) =>
        truncateJsonTextForOtelAttribute(text, maxStringChars),
      );
      const json = stringifyJsonForOtelAttribute(candidate);
      if (json && json.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS) {
        return json;
      }
    }
  }
  const summary = stringifyJsonForOtelAttribute({
    truncated: true,
    reason: summaryReason(value, redactionCapped),
    type: describeJsonValue(value),
  });
  return summary && summary.length <= MAX_OTEL_CONTENT_ATTRIBUTE_CHARS ? summary : undefined;
}

// A candidate that fit the attribute but not the redaction cap was dropped for its redaction
// cost, not its size.
function summaryReason(value: unknown, redactionCapped: boolean): string {
  if (!stringifyJson(value)) {
    return "unserializable_value";
  }
  return redactionCapped ? "max_redaction_work" : "max_attribute_size";
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

// `truncateText` clips each string to the candidate's string budget; the budget search counts
// redaction work with one callback and exports with another.
function truncateJsonValueForOtelAttribute(
  input: unknown,
  maxArrayItems: number,
  truncateText: (value: string) => string,
): unknown {
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): unknown {
    if (typeof value === "string" || typeof value === "bigint") {
      return truncateText(String(value));
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      return value;
    }
    if (typeof value !== "object") {
      return undefined;
    }
    if (depth <= 0) {
      return { truncated: true, reason: "max_depth" };
    }
    if (seen.has(value)) {
      const marker = { truncated: true, reason: "circular_reference" };
      return Array.isArray(value) ? [marker] : marker;
    }
    seen.add(value);
    let result: unknown;
    if (Array.isArray(value)) {
      const items = value.slice(0, maxArrayItems).map((item) => visit(item, depth - 1));
      if (value.length > items.length) {
        items.push({ truncated: true, omittedItems: value.length - items.length });
      }
      result = items;
    } else {
      const object: Record<string, unknown> = {};
      const entries = Object.entries(value).filter(([, field]) => !isOmittedFromJson(field));
      for (const [key, field] of entries.slice(0, JSON_TRUNCATION_MAX_OBJECT_FIELDS)) {
        object[key] = visit(field, depth - 1);
      }
      if (entries.length > JSON_TRUNCATION_MAX_OBJECT_FIELDS) {
        object.truncated = true;
        object.omittedFields = entries.length - JSON_TRUNCATION_MAX_OBJECT_FIELDS;
      }
      result = object;
    }
    seen.delete(value);
    return result;
  }
  return visit(input, JSON_TRUNCATION_MAX_DEPTH);
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
