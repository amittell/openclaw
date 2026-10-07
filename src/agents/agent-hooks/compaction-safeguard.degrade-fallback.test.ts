/**
 * Pins the fork's degrade-to-fallback behaviour at the compaction quality guard's
 * terminal branch: when the last permitted attempt still fails the quality audit,
 * the safeguard emits a structured fallback summary instead of cancelling the
 * compaction. Cancelling there strands the session, because the transcript never
 * shrinks and every later turn fails preflight.
 *
 * Lives beside compaction-safeguard.test.ts rather than inside it: the behaviour is
 * fork-only, and upstream carries no file at this path, so future upstream merges
 * cannot conflict with it.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import {
  consumeCompactionSafeguardCancellation,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

vi.mock("./compaction-safeguard-quality.js", async () => {
  const actual = await vi.importActual<typeof compactionQualityModule>(
    "./compaction-safeguard-quality.js",
  );
  return { ...actual, auditSummaryQuality: vi.fn(actual.auditSummaryQuality) };
});

vi.mock("../compaction.js", async () => {
  const actual = await vi.importActual<typeof compactionModule>("../compaction.js");
  return { ...actual, summarizeInStages: vi.fn(actual.summarizeInStages) };
});

const mockSummarizeInStages = vi.mocked(compactionModule.summarizeInStages);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);

/** Text the LLM "produces" and the quality guard then rejects on every attempt. */
const REJECTED_SUMMARY = "REJECTED_LLM_SUMMARY_MARKER rejected draft body";
/** Prior summary the structured fallback must carry forward when it degrades. */
const PRIOR_SUMMARY = "PRIOR_SUMMARY_MARKER earlier session work";
const QUALITY_REASONS = ["missing_section:## Decisions", "missing_identifiers:ABC-123"];

beforeEach(() => {
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  mockSummarizeInStages.mockReset();
  mockSummarizeInStages.mockResolvedValue(REJECTED_SUMMARY);
  mockAuditSummaryQuality.mockReset();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
  resetPluginRuntimeStateForTest();
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

function createAnthropicModelFixture(): Model {
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
  };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function createCompactionHandler(): CompactionHandler {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
    // SAFETY: the literal supplies the only ExtensionAPI member the safeguard calls (`on`); the
    // handler throws below if registration did not happen, so an unused surface cannot go unnoticed.
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  return compactionHandler;
}

function createCompactionContext(sessionManager: ExtensionContext["sessionManager"]) {
  return {
    model: undefined,
    sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
    },
    // SAFETY: supplies the three ExtensionContext members the compaction handler reads
    // (model, sessionManager, modelRegistry); every other member is unreached on this path.
  } as unknown as Partial<ExtensionContext>;
}

function createCompactionEvent() {
  const messagesToSummarize: AgentMessage[] = castAgentMessages([
    { role: "user", content: "older context", timestamp: 1 },
    { role: "assistant", content: "older reply", timestamp: 2 },
    { role: "user", content: "latest ask status", timestamp: 3 },
  ]);
  const turnPrefixMessages: AgentMessage[] = [];
  return {
    preparation: {
      messagesToSummarize,
      turnPrefixMessages,
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_500,
      fileOps: { read: [], edited: [], written: [] },
      settings: { reserveTokens: 4_000 },
      previousSummary: PRIOR_SUMMARY,
      isSplitTurn: false,
    },
    customInstructions: "",
    signal: new AbortController().signal,
  };
}

type CompactionOutcome = {
  cancel?: boolean;
  compaction?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number };
};

/**
 * Drives the handler with a quality audit that always rejects, so the retry budget
 * is exhausted and control reaches the terminal branch under test.
 */
async function runUntilQualityGuardExhausted(): Promise<{
  result: CompactionOutcome;
  sessionManager: ExtensionContext["sessionManager"];
}> {
  mockAuditSummaryQuality.mockReturnValue({ ok: false, reasons: [...QUALITY_REASONS] });
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model: createAnthropicModelFixture(),
    recentTurnsPreserve: 1,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
  });
  const compactionHandler = createCompactionHandler();
  const result = (await compactionHandler(
    createCompactionEvent(),
    createCompactionContext(sessionManager),
    // SAFETY: the handler's declared return is the compaction decision union; this narrows to the
    // two arms the assertions read, and every field is optional so a wrong arm fails the assertion.
  )) as CompactionOutcome;
  return { result, sessionManager };
}

describe("compaction-safeguard quality-guard exhaustion", () => {
  it("degrades to a structured fallback summary instead of cancelling the compaction", async () => {
    const { result } = await runUntilQualityGuardExhausted();

    expect(result.cancel).not.toBe(true);
    expect(typeof result.compaction?.summary).toBe("string");
    expect(result.compaction?.firstKeptEntryId).toBe("entry-1");
  });

  it("carries the previous summary forward and discards the rejected draft", async () => {
    const { result } = await runUntilQualityGuardExhausted();
    const summary = result.compaction?.summary ?? "";

    expect(summary).toContain("PRIOR_SUMMARY_MARKER");
    expect(summary).toContain("## Decisions");
    expect(summary).not.toContain("REJECTED_LLM_SUMMARY_MARKER");
  });

  it("leaves no safeguard cancellation, so the session is not stranded", async () => {
    const { sessionManager } = await runUntilQualityGuardExhausted();

    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("logs the degraded-fallback reason code with the deduped audit reason codes", async () => {
    await runUntilQualityGuardExhausted();
    const warnings = compactionLogger.warn.mock.calls.flat().join("\n");

    expect(warnings).toContain("reasonCode=quality_guard_degraded_fallback");
    expect(warnings).toContain("reasonCodes=missing_section,missing_identifiers");
    expect(warnings).toContain("reasonCount=2");
  });

  it("exhausts the retry budget before degrading", async () => {
    await runUntilQualityGuardExhausted();

    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(mockAuditSummaryQuality).toHaveBeenCalledTimes(2);
  });

  it("still returns a passing summary untouched when the quality audit accepts it", async () => {
    mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
    mockSummarizeInStages.mockResolvedValue(
      ["## Decisions", "d", "## Open TODOs", "None.", "## Constraints/Rules", "None."].join("\n"),
    );
    const sessionManager = stubSessionManager();
    setCompactionSafeguardRuntime(sessionManager, {
      model: createAnthropicModelFixture(),
      recentTurnsPreserve: 1,
      qualityGuardEnabled: false,
    });
    const compactionHandler = createCompactionHandler();
    const result = (await compactionHandler(
      createCompactionEvent(),
      createCompactionContext(sessionManager),
      // SAFETY: same decision union as above, narrowed to the arms this control reads.
    )) as CompactionOutcome;

    expect(result.cancel).not.toBe(true);
    expect(result.compaction?.summary).toContain("## Decisions");
    expect(compactionLogger.warn.mock.calls.flat().join("\n")).not.toContain(
      "quality_guard_degraded_fallback",
    );
  });
});
