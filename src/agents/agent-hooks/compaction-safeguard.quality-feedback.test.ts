/**
 * Pins the corrective boundary of the compaction quality guard: the regeneration
 * instruction names only COMPLETE missing identifiers and records how many it could not
 * name. Identifier length is unbounded, so a char budget alone cannot show all twelve; a
 * value cut mid-string is a value the corrective pass restores wrongly and the retry then
 * fails the same audit. These cases drive the largest input the extractor accepts —
 * MAX_EXTRACTED_IDENTIFIERS values at a length whose join overruns any fixed wrapper cap.
 *
 * Lives beside compaction-safeguard.test.ts, which is grandfathered over the max-lines cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeCompactionHistory } from "../compaction.js";
import {
  auditSummaryQuality,
  formatQualityFeedbackReasons,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";
import {
  createCompactionEvent,
  createQualityGuardSessionManager,
  runCompactionScenario,
  structuredSummary,
  testing,
} from "./compaction-safeguard.test-support.js";

const LATEST_ASK = "report the deployment status";
/**
 * The fork's identifier budget: MAX_QUALITY_FEEDBACK_INSTRUCTION_CHARS (8000) minus its 800-char
 * reserve, in compaction-safeguard-quality.ts. Upstream #138415 sizes the same budget to its
 * 4000-char block (3400 and 600); the fork routes the defect list through its 8000-char block.
 */
const IDENTIFIER_BUDGET_CHARS = 7200;
/** The reserve compaction-safeguard-quality.ts keeps outside the identifier budget. */
const NON_IDENTIFIER_RESERVE_CHARS = 800;
/** Unique per identifier, so a rendered head proves that value reached the prompt. */
const identifierHead = (index: number) => `https://example.com/paths/segment-${index}/`;
// Twelve distinct 700-char URLs run past both the 4000-char untrusted wrapper and the
// fork's 7,200-char identifier budget; ten fit it whole.
const LONG_IDENTIFIERS = Array.from({ length: 12 }, (_, index) =>
  identifierHead(index).padEnd(700, "x"),
);
const SHORT_IDENTIFIERS = Array.from({ length: 12 }, (_, index) => `id-${index}`);
const LATER_IDENTIFIERS = SHORT_IDENTIFIERS.slice(0, 11);
const BUDGET_FILLER = "https://example.com/fill/".padEnd(IDENTIFIER_BUDGET_CHARS, "f");

// Duplicate/missing headings plus an unresolved retained ask drive all co-occurring reasons.
const auditWorstCase = (identifiers: string[]) =>
  auditSummaryQuality({
    summary: "Nothing preserved.",
    structuralSummary: "Nothing preserved.",
    sourceSummaries: [
      ["Decisions", "Open TODOs", "Constraints/Rules", "Pending user asks", "Exact identifiers"]
        .map((heading) => `## ${heading}\n## ${heading}`)
        .join("\n"),
    ],
    identifiers,
    latestAsk: LATEST_ASK,
    latestUnresolvedUserRequest: LATEST_ASK,
    retainedTurnSummary: `## Pending user asks\n${LATEST_ASK}`,
  }).reasons;

/** Identifiers whose unique head reached the prompt without the rest of the value. */
function partiallyRenderedIdentifiers(promptText: string): string[] {
  return LONG_IDENTIFIERS.filter(
    (identifier, index) =>
      promptText.includes(identifierHead(index)) && !promptText.includes(identifier),
  ).map((identifier) => `${identifier.slice(0, 40)}...`);
}

const mockSummarizeCompactionHistory = vi.fn<typeof summarizeCompactionHistory>();

beforeEach(() => {
  mockSummarizeCompactionHistory.mockReset();
  testing.setSummarizeCompactionHistoryForTest(mockSummarizeCompactionHistory);
});

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
});

function customInstructionsOfSummarizeCall(callIndex: number): string {
  const instructions =
    mockSummarizeCompactionHistory.mock.calls[callIndex]?.[0]?.customInstructions;
  if (typeof instructions !== "string") {
    throw new Error(`expected summarize call ${callIndex + 1} to carry custom instructions`);
  }
  return instructions;
}

describe("compaction-safeguard corrective quality feedback", () => {
  // 10, not upstream's 4: the budget here is the fork's wider feedback block.
  it.each<[string, string[], string[], number]>([
    ["long values", LONG_IDENTIFIERS, LONG_IDENTIFIERS.slice(0, 10), 2],
    ["exact budget fill", [BUDGET_FILLER, ...LATER_IDENTIFIERS], [BUDGET_FILLER], 11],
    ["short values", SHORT_IDENTIFIERS, SHORT_IDENTIFIERS, 0],
    [
      "oversized first value",
      ["x".repeat(IDENTIFIER_BUDGET_CHARS + 1), ...LATER_IDENTIFIERS],
      LATER_IDENTIFIERS,
      1,
    ],
  ])(
    "preserves whole identifiers and bounded feedback: %s",
    (_name, identifiers, expected, omitted) => {
      const reasons = auditWorstCase(identifiers);
      const listed = reasons.find((reason) => reason.startsWith("missing_identifiers:"));
      expect(listed?.slice("missing_identifiers:".length).split(",") ?? []).toStrictEqual(expected);
      expect(reasons.filter((reason) => reason.startsWith("missing_identifiers_omitted:"))).toEqual(
        omitted ? [`missing_identifiers_omitted:${omitted}`] : [],
      );
      expect(reasons.length).toBeGreaterThanOrEqual(13);
      expect(reasons).toContain("latest_user_ask_not_foregrounded");
      const feedback = `Previous summary failed quality checks (${reasons.join(", ")}).`;
      expect(feedback.length - expected.join(",").length).toBeLessThanOrEqual(
        NON_IDENTIFIER_RESERVE_CHARS,
      );
      // The fork routes the defect list through its own wider block; the operator-text block
      // below keeps the 4000-char cap and is anchored separately.
      expect(formatQualityFeedbackReasons(reasons.join(", "))).toContain(feedback);
    },
  );

  it("leaves no partial identifier in the corrective instruction", () => {
    const corrective = formatQualityFeedbackReasons(auditWorstCase(LONG_IDENTIFIERS).join(", "));

    // A head present without its whole value is the mid-item cut this guard removes.
    expect(partiallyRenderedIdentifiers(corrective)).toStrictEqual([]);
  });

  it("keeps the 4000-char cap for operator-supplied context (anchor control)", () => {
    const overCapText = "y".repeat(4200);
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", overCapText),
    ).not.toContain(overCapText);
  });

  it("sends whole identifiers plus the omitted count to the corrective pass", async () => {
    // The finalizer repairs a well-formed summary's identifier section itself, so the defect
    // list only reaches the model when a heading is missing too: drop ## Exact identifiers.
    const failingSummary = [
      "## Decisions",
      "Keep flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Follow rules.",
      "## Pending user asks",
      LATEST_ASK,
    ].join("\n");
    mockSummarizeCompactionHistory
      .mockResolvedValueOnce(failingSummary)
      .mockResolvedValueOnce(
        structuredSummary({ asks: LATEST_ASK, identifiers: LONG_IDENTIFIERS.join("\n") }),
      );

    const { result } = await runCompactionScenario(
      createQualityGuardSessionManager(),
      createCompactionEvent({ messageText: `${LATEST_ASK} ${LONG_IDENTIFIERS.join(" ")}` }),
    );

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
    expect(customInstructionsOfSummarizeCall(0)).not.toContain("Quality check feedback");
    const corrective = customInstructionsOfSummarizeCall(1);
    expect(corrective).toContain("Quality check feedback");
    expect(partiallyRenderedIdentifiers(corrective)).toStrictEqual([]);
    expect(corrective).toContain("missing_identifiers_omitted:");
  });
});
