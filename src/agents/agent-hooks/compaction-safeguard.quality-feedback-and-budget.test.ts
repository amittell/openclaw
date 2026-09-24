/**
 * Pins the fork's #721 fix at the compaction quality guard's corrective boundary:
 * the corrective regeneration instruction carries the COMPLETE missing-identifiers
 * defect list. The audit used to name only the first three, and the 4000-char
 * operator-text wrapper cut the rest mid-list, so the model never saw which
 * identifiers to restore and the retry failed the same audit.
 *
 * The #723 session-scaled budget this file also pinned was dropped in the 9.6
 * carry for #138416, whose finalizer stays inside the 16,000-char persistence cap.
 *
 * Lives beside compaction-safeguard.test.ts: that suite is grandfathered over the
 * max-lines cap, and upstream carries no file at this path, so merges cannot conflict.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
