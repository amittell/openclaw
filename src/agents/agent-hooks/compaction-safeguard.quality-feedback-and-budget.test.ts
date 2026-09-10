/**
 * Pins two fork fixes at the compaction quality guard's corrective boundary:
 *
 * - #721: the corrective regeneration instruction carries the COMPLETE
 *   missing-identifiers defect list. The audit used to name only the first three,
 *   and the 4000-char operator-text wrapper cut the rest mid-list, so the model
 *   never saw which identifiers to restore and the retry failed the same audit.
 * - #723: the finalized summary budget scales with the summarizable session size,
 *   capped by what the summarizer can actually emit (its output budget), instead of
 *   a fixed 16k that truncated large sessions to a sliver and failed the audit on
 *   the truncation.
 *
 * Lives beside compaction-safeguard.test.ts: that suite is grandfathered over the
 * max-lines cap, and upstream carries no file at this path, so merges cannot conflict.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARIZATION_OVERHEAD_TOKENS } from "../compaction-planning.js";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  auditSummaryQuality,
  wrapUntrustedInstructionBlock,
  wrapUntrustedQualityFeedbackBlock,
} from "./compaction-safeguard-quality.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const {
  resolveCompactionSummaryBudgetChars,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARIZER_CHARS_PER_TOKEN,
  SUMMARIZER_OUTPUT_BUDGET_RATIO,
  SUMMARY_TRUNCATED_MARKER,
} = testing;

const LATEST_ASK = "report the deployment status";
/** Twelve ~410-char URLs: joined they overrun the legacy 4000-char untrusted wrapper. */
const LONG_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) =>
    `https://example.com/paths/segment-${String(index).padStart(2, "0")}/${"artifact-bundle".repeat(24)}.bundle.js.map`,
);

function structuredSummary(sections: {
  decisions?: string;
  pendingAsks: string;
  identifiers: string;
}): string {
  return [
    "## Decisions",
    sections.decisions ?? "Keep flow.",
    "## Open TODOs",
    "None.",
    "## Constraints/Rules",
    "Follow rules.",
    "## Pending user asks",
    sections.pendingAsks,
    "## Exact identifiers",
    sections.identifiers,
  ].join("\n");
}

const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();

beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
});

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CompactionOutcome = { cancel?: boolean; compaction?: { summary?: string } };

/** Runs one quality-guarded, non-split compaction of a single user message. */
async function runQualityGuardCompaction(params: {
  model: Model;
  messageText: string;
}): Promise<CompactionOutcome> {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
    // SAFETY: the literal supplies the only ExtensionAPI member the safeguard calls (`on`); the
    // throw below catches a registration that did not happen.
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model: params.model,
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
  });
  const event = {
    preparation: {
      messagesToSummarize: castAgentMessages([
        { role: "user", content: params.messageText, timestamp: 1 },
      ]),
      turnPrefixMessages: [] as AgentMessage[],
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_500,
      fileOps: { read: [], edited: [], written: [] },
      settings: { reserveTokens: 4_000 },
      isSplitTurn: false,
    },
    customInstructions: "",
    signal: new AbortController().signal,
  };
  const ctx = {
    model: undefined,
    sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
    },
    // SAFETY: supplies the three ExtensionContext members the handler reads (model,
    // sessionManager, modelRegistry); every other member is unreached on this path.
  } as unknown as Partial<ExtensionContext>;
  // SAFETY: the handler's declared return is the compaction decision union; this narrows to
  // the two arms the assertions read, and every field is optional so a wrong arm fails them.
  return (await compactionHandler(event, ctx)) as CompactionOutcome;
}

function customInstructionsOfSummarizeCall(callIndex: number): string {
  const instructions = mockSummarizeInStages.mock.calls[callIndex]?.[0]?.customInstructions;
  if (typeof instructions !== "string") {
    throw new Error(`expected summarize call ${callIndex + 1} to carry custom instructions`);
  }
  return instructions;
}

describe("compaction-safeguard corrective quality feedback (#721)", () => {
  it("names every missing identifier in the audit reason, not only the first three", () => {
    const summary = structuredSummary({ pendingAsks: LATEST_ASK, identifiers: "None." });

    const { reasons } = auditSummaryQuality({
      summary,
      structuralSummary: summary,
      identifiers: LONG_IDENTIFIERS,
      latestAsk: LATEST_ASK,
    });

    expect(reasons).toStrictEqual([`missing_identifiers:${LONG_IDENTIFIERS.join(",")}`]);
  });

  it("gives the defect list an untrusted budget that outlives the 4000-char operator-text cap", () => {
    const defectList = `Previous summary failed quality checks (missing_identifiers:${LONG_IDENTIFIERS.join(",")}).`;
    expect(defectList.length).toBeGreaterThan(4000);

    expect(wrapUntrustedQualityFeedbackBlock("Quality check feedback", defectList)).toContain(
      defectList,
    );
    // Operator-supplied context keeps the legacy cap; the wider budget is scoped to audit output.
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", defectList),
    ).not.toContain(defectList);
  });

  it("sends the complete >4000-char missing-identifiers list to the corrective pass", async () => {
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
    mockSummarizeInStages
      .mockResolvedValueOnce(failingSummary)
      .mockResolvedValueOnce(
        structuredSummary({ pendingAsks: LATEST_ASK, identifiers: LONG_IDENTIFIERS.join(", ") }),
      );

    const result = await runQualityGuardCompaction({
      model: createAnthropicModelFixture(),
      messageText: `${LATEST_ASK} ${LONG_IDENTIFIERS.join(" ")}`,
    });

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(customInstructionsOfSummarizeCall(0)).not.toContain("Quality check feedback");
    const corrective = customInstructionsOfSummarizeCall(1);
    expect(corrective).toContain("Quality check feedback");
    for (const identifier of LONG_IDENTIFIERS) {
      expect(corrective).toContain(identifier);
    }
  });
});

describe("compaction-safeguard summary budget (#723)", () => {
  it("clamps the budget between the legacy 16k floor and the summarizer's output ceiling", () => {
    const model = createAnthropicModelFixture({ maxTokens: 32_000 });
    // Small session: the floor is unchanged legacy behavior.
    expect(resolveCompactionSummaryBudgetChars({ model, serializedChars: 4_000 })).toBe(
      MAX_COMPACTION_SUMMARY_CHARS,
    );
    // No maxTokens metadata: the ceiling is the floor itself.
    expect(
      resolveCompactionSummaryBudgetChars({
        model: createAnthropicModelFixture({ maxTokens: undefined }),
        serializedChars: 1_000_000,
      }),
    ).toBe(MAX_COMPACTION_SUMMARY_CHARS);
    // Large session: the budget grows with serialized size, capped at
    // floor + maxOutputTokens * SUMMARIZER_OUTPUT_BUDGET_RATIO * SUMMARIZER_CHARS_PER_TOKEN.
    const ceiling =
      MAX_COMPACTION_SUMMARY_CHARS +
      (32_000 - SUMMARIZATION_OVERHEAD_TOKENS) *
        SUMMARIZER_OUTPUT_BUDGET_RATIO *
        SUMMARIZER_CHARS_PER_TOKEN;
    const largeBudget = resolveCompactionSummaryBudgetChars({ model, serializedChars: 1_000_000 });
    expect(largeBudget).toBe(ceiling);
    expect(largeBudget).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    // Between floor and ceiling the budget equals the session size: every
    // serialized char can be represented in the artifact.
    expect(resolveCompactionSummaryBudgetChars({ model, serializedChars: 40_000 })).toBe(40_000);
  });

  const OVERSIZED_DECISIONS = "x".repeat(20_000);
  const IDENTIFIER = "/tmp/compaction-scaling-audit.log";
  /** A ~1M-char session: at the legacy 16k cap its perfect summary lost its tail sections. */
  const LARGE_SESSION_TEXT = `session payload ${"x".repeat(1_000_000)} ${LATEST_ASK} ${IDENTIFIER}`;
  /** A perfect structured body that only fits once the budget exceeds the legacy 16k cap. */
  const oversizedSummary = () =>
    structuredSummary({
      decisions: OVERSIZED_DECISIONS,
      pendingAsks: `${LATEST_ASK} ${IDENTIFIER}`,
      identifiers: IDENTIFIER,
    });

  it("lets a ~1M-char session keep every required section untruncated when the summarizer has output headroom", async () => {
    mockSummarizeInStages.mockResolvedValue(oversizedSummary());

    const result = await runQualityGuardCompaction({
      model: createAnthropicModelFixture({ maxTokens: 32_000 }),
      messageText: LARGE_SESSION_TEXT,
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    for (const section of [
      "## Decisions",
      "## Open TODOs",
      "## Constraints/Rules",
      "## Pending user asks",
      "## Exact identifiers",
    ]) {
      expect(summary).toContain(section);
    }
    expect(summary).toContain(IDENTIFIER);
    // The body's filler survives finalization verbatim: no truncation at the scaled
    // budget (the legacy 16k cap cut it away entirely).
    expect(summary).toContain(OVERSIZED_DECISIONS);
    expect(summary).not.toContain(SUMMARY_TRUNCATED_MARKER.trim());
    // The audit passed on the first attempt: nothing was truncated for it to reject.
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy 16k floor when the summarizer has no output headroom (anchor control)", async () => {
    mockSummarizeInStages.mockResolvedValue(oversizedSummary());

    // The default fixture's maxTokens equals the summarization overhead, so the
    // ceiling collapses to the floor and finalization behaves exactly as before.
    const result = await runQualityGuardCompaction({
      model: createAnthropicModelFixture({ maxTokens: SUMMARIZATION_OVERHEAD_TOKENS }),
      messageText: LARGE_SESSION_TEXT,
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(summary).not.toContain(OVERSIZED_DECISIONS);
  });
});
