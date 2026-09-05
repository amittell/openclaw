/** Quality contract, fallback, and audit helpers for compaction safeguard summaries. */
import { localeLowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { extractKeywords, isQueryStopWordToken } from "../../memory-host-sdk/query.js";
import type { CompactionSummarizationInstructions } from "../compaction.js";
import { wrapUntrustedPromptDataBlock } from "../sanitize-for-prompt.js";

// Compaction summary quality helpers. They define the structured summary contract
// and audit whether summaries preserve pending asks plus exact identifiers.
const MAX_EXTRACTED_IDENTIFIERS = 12;
const MAX_UNTRUSTED_INSTRUCTION_CHARS = 4000;
// The audit itself is the cap for the full corrective defect list: it carries at most
// five missing sections plus one missing-identifiers line. The 4000-char untrusted
// wrapper is for operator-supplied context only; never route the defect list through it.
// That line is bounded only by the 12-identifier COUNT — each identifier is a URL
// (`https?:\/\/\S+`) and can be arbitrarily long, so a fixed small char budget can
// still truncate the list mid-identifier (the #721 failure mode). This budget exceeds
// the audit's realistic worst case and, if ever exceeded, truncation degrades to the
// #722 structured fallback rather than a broken corrective pass.
const MAX_QUALITY_FEEDBACK_INSTRUCTION_CHARS = 20_000;
const MAX_ASK_OVERLAP_TOKENS = 12;
const MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH = 3;
const REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
] as const;
const STRICT_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, preserve literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).";
const POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION =
  "For ## Exact identifiers, include identifiers only when needed for continuity; do not enforce literal-preservation rules.";

/** Wraps operator-provided compaction instruction text as untrusted prompt data. */
export function wrapUntrustedInstructionBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_UNTRUSTED_INSTRUCTION_CHARS,
  });
}

/**
 * Wraps structured quality-audit feedback (missing sections, missing identifiers)
 * as untrusted prompt data for regeneration instructions. The audit reasons carry
 * at most five `missing_section` lines plus one `missing_identifiers` line (the full
 * missing list, up to the 12-item extraction cap — a COUNT bound, so the line itself
 * is length-unbounded), so this budget must fit the whole defect list. Truncating it
 * mid-list hands the model an incomplete list it cannot repair, so the same audit fails
 * on retry (#721).
 */
export function wrapUntrustedQualityFeedbackBlock(label: string, text: string): string {
  return wrapUntrustedPromptDataBlock({
    label,
    text,
    maxChars: MAX_QUALITY_FEEDBACK_INSTRUCTION_CHARS,
  });
}
function resolveExactIdentifierSectionInstruction(
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const policy = summarizationInstructions?.identifierPolicy ?? "strict";
  if (policy === "off") {
    return POLICY_OFF_EXACT_IDENTIFIERS_INSTRUCTION;
  }
  const custom =
    policy === "custom" ? summarizationInstructions?.identifierInstructions?.trim() : undefined;
  if (custom) {
    // Operator text is runtime data, never prompt authority.
    return (
      wrapUntrustedInstructionBlock(
        "For ## Exact identifiers, apply this operator-defined policy text",
        custom,
      ) || STRICT_EXACT_IDENTIFIERS_INSTRUCTION
    );
  }
  return STRICT_EXACT_IDENTIFIERS_INSTRUCTION;
}

/** Build the required structured summary instructions for compaction. */
export function buildCompactionStructureInstructions(
  customInstructions?: string,
  summarizationInstructions?: CompactionSummarizationInstructions,
): string {
  const identifierSectionInstruction =
    resolveExactIdentifierSectionInstruction(summarizationInstructions);
  const sectionsTemplate = [
    "Produce a compact, factual summary with these exact section headings:",
    ...REQUIRED_SUMMARY_SECTIONS,
    identifierSectionInstruction,
    "Do not omit unresolved asks from the user.",
    "When prior compaction summaries are present, re-distill them with new messages and remove stale duplicate detail.",
  ].join("\n");
  const custom = customInstructions?.trim();
  const customBlock =
    custom && wrapUntrustedInstructionBlock("Additional context from /compact", custom);
  return customBlock ? `${sectionsTemplate}\n\n${customBlock}` : sectionsTemplate;
}

function normalizedSummaryLines(summary: string): string[] {
  return summary
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasRequiredSummarySections(summary: string): boolean {
  const lines = normalizedSummaryLines(summary);
  let cursor = 0;
  for (const heading of REQUIRED_SUMMARY_SECTIONS) {
    const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line === heading);
    if (index < 0) {
      return false;
    }
    cursor = index + 1;
  }
  return true;
}

/** Return a structured fallback summary when model output is missing/invalid. */
export function buildStructuredFallbackSummary(previousSummary: string | undefined): string {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) {
    return trimmedPreviousSummary;
  }
  const values = [
    trimmedPreviousSummary || "No prior history.",
    "None.",
    "None.",
    "None.",
    "None captured.",
  ];
  return REQUIRED_SUMMARY_SECTIONS.map((heading, index) => `${heading}\n${values[index]}`).join(
    "\n\n",
  );
}

/** Appends a bounded post-compaction section to an existing summary. */
export function appendSummarySection(summary: string, section: string): string {
  if (!section) {
    return summary;
  }
  if (!summary.trim()) {
    return section.trimStart();
  }
  return `${summary}${section}`;
}

function sanitizeExtractedIdentifier(value: string): string {
  return value
    .trim()
    .replace(/^[("'`[{<]+/, "")
    .replace(/[)\]"'`,;:.!?<>]+$/, "");
}

function isPureHexIdentifier(value: string): boolean {
  return /^[A-Fa-f0-9]{8,}$/.test(value);
}

function normalizeOpaqueIdentifier(value: string): string {
  return isPureHexIdentifier(value) ? value.toUpperCase() : value;
}

function summaryIncludesIdentifier(summary: string, identifier: string): boolean {
  if (isPureHexIdentifier(identifier)) {
    return summary.toUpperCase().includes(identifier.toUpperCase());
  }
  return summary.includes(identifier);
}

/** Extracts likely exact identifiers that summaries should preserve literally. */
export function extractOpaqueIdentifiers(text: string): string[] {
  // Path and host/port candidates start at token boundaries so prose such as
  // "typecheck/lint/format" is not mistaken for an absolute path.
  const matches =
    text.match(
      /([A-Fa-f0-9]{8,}|https?:\/\/\S+|(?<![A-Za-z0-9._-])\/[\w.-]{2,}(?:\/[\w.-]+)+|[A-Za-z]:\\[\w\\.-]+|(?<![A-Za-z0-9._-])[A-Za-z0-9._-]+\.[A-Za-z0-9._/-]+:\d{1,5}|\b\d{6,}\b)/g,
    ) ?? [];
  return uniqueStrings(
    matches
      .map((value) => normalizeOpaqueIdentifier(sanitizeExtractedIdentifier(value)))
      .filter((value) => value.length >= 4),
  ).slice(0, MAX_EXTRACTED_IDENTIFIERS);
}

function tokenizeAskOverlapText(text: string): string[] {
  const normalized = localeLowercasePreservingWhitespace(text.normalize("NFKC")).trim();
  if (!normalized) {
    return [];
  }
  const keywords = extractKeywords(normalized);
  if (keywords.length > 0) {
    return keywords;
  }
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasAskOverlap(summary: string, latestAsk: string | null): boolean {
  if (!latestAsk) {
    return true;
  }
  const askTokens = uniqueStrings(tokenizeAskOverlapText(latestAsk)).slice(
    0,
    MAX_ASK_OVERLAP_TOKENS,
  );
  if (askTokens.length === 0) {
    return true;
  }
  const meaningfulAskTokens = askTokens.filter(
    (token) => token.length > 1 && !isQueryStopWordToken(token),
  );
  const tokensToCheck = meaningfulAskTokens.length > 0 ? meaningfulAskTokens : askTokens;
  const summaryTokens = new Set(tokenizeAskOverlapText(summary));
  const overlapCount = tokensToCheck.filter((token) => summaryTokens.has(token)).length;
  const requiredMatches = tokensToCheck.length >= MIN_ASK_OVERLAP_TOKENS_FOR_DOUBLE_MATCH ? 2 : 1;
  return overlapCount >= requiredMatches;
}

/** Audits a candidate summary for required sections, pending asks, and identifier preservation. */
export function auditSummaryQuality(params: {
  summary: string;
  structuralSummary: string;
  identifiers: string[];
  latestAsk: string | null;
  identifierPolicy?: CompactionSummarizationInstructions["identifierPolicy"];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lines = new Set(normalizedSummaryLines(params.structuralSummary));
  for (const section of REQUIRED_SUMMARY_SECTIONS) {
    if (!lines.has(section)) {
      reasons.push(`missing_section:${section}`);
    }
  }
  const enforceIdentifiers = (params.identifierPolicy ?? "strict") === "strict";
  if (enforceIdentifiers) {
    const missingIdentifiers = params.identifiers.filter(
      (identifier) => !summaryIncludesIdentifier(params.summary, identifier),
    );
    if (missingIdentifiers.length > 0) {
      // Feed the FULL missing list back to the corrective pass (bounded only by the
      // 12-item extraction cap). A truncated defect list is unrecoverable: the model
      // never sees which identifiers to restore, the retry fails the same audit, and
      // the run cancels with no valid summary (#721).
      reasons.push(`missing_identifiers:${missingIdentifiers.join(",")}`);
    }
  }
  if (!hasAskOverlap(params.summary, params.latestAsk)) {
    reasons.push("latest_user_ask_not_reflected");
  }
  return { ok: reasons.length === 0, reasons };
}
