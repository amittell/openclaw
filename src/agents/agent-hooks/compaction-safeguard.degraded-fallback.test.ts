/**
 * Pins the safeguard's terminal quality path: when the final audit fails, or the required facts
 * cannot fit the finalized budget, the safeguard commits a bounded fallback marked
 * `qualityDegraded` instead of cancelling, so the session can still shrink.
 *
 * Lives beside compaction-safeguard.test.ts, which is grandfathered over the line cap.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
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

const { MAX_COMPACTION_SUMMARY_CHARS, CONTEXT_TRUNCATED_MARKER } = testing;
const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();

beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
});

function userMessage(content: string, timestamp: number): AgentMessage {
  return { role: "user", content, timestamp };
}

function stubSessionManager(): ExtensionContext["sessionManager"] {
  return {
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
}

const model: Model = {
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "anthropic",
  api: "anthropic",
  baseUrl: "https://api.anthropic.com",
  contextWindow: 200000,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
  cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
};

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CompactionOutcome = { cancel?: boolean; compaction?: { summary: string; details?: unknown } };

/** One terminal-attempt safeguard compaction: qualityGuardMaxRetries 0 makes a failed audit final. */
async function runTerminalAttempt(params: {
  preparation: Record<string, unknown>;
  recentTurnsPreserve?: number;
}) {
  let handler: CompactionHandler | undefined;
  compactionSafeguardExtension({
    on: (event: string, next: CompactionHandler) => {
      if (event === "session_before_compact") {
        handler = next;
      }
    },
  } as unknown as ExtensionAPI);
  if (!handler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model,
    recentTurnsPreserve: params.recentTurnsPreserve ?? 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 0,
  });
  const result = (await handler(
    {
      preparation: {
        messagesToSummarize: [],
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 1_500,
        fileOps: { read: [], edited: [], written: [] },
        settings: { reserveTokens: 4_000 },
        isSplitTurn: false,
        ...params.preparation,
      },
      customInstructions: "",
      signal: new AbortController().signal,
    },
    {
      model: undefined,
      sessionManager,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }) },
    },
  )) as CompactionOutcome;
  return { result, sessionManager };
}

/** Asserts the committed, degraded boundary and returns its summary. */
function degradedSummary(result: CompactionOutcome): string {
  expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
  return result.compaction?.summary ?? "";
}

describe("compaction-safeguard degraded fallback", () => {
  it.each([
    { name: "source ask", runOwnedRequest: false },
    { name: "run-owned request", runOwnedRequest: true },
  ])(
    "degrades with the $name when an identifier cannot fit the artifact cap",
    async ({ runOwnedRequest }) => {
      const latestAsk = "preserve the pending deployment status";
      const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
      const fittingIdentifier = "/var/log/deploy-status.log";
      mockSummarizeInStages.mockResolvedValue(
        [
          "## Decisions",
          "Keep current flow.",
          "## Open TODOs",
          "None.",
          "## Constraints/Rules",
          "Preserve exact context.",
          "## Pending user asks",
          latestAsk,
          "## Exact identifiers",
          identifier,
        ].join("\n"),
      );

      const { result, sessionManager } = await runTerminalAttempt({
        preparation: {
          messagesToSummarize: [
            userMessage(`the status log is ${fittingIdentifier}`, 1),
            userMessage(`${latestAsk} ${identifier}`, 2),
          ],
          // The session owner bounds a run-owned request to 800 chars before it gets here.
          ...(runOwnedRequest ? { latestUnresolvedUserRequest: latestAsk } : {}),
        },
      });

      // Cancelling here left the session permanently uncompactable: the required facts
      // never shrink, so every later attempt hits the same wall. Both terminal quality
      // paths now commit the same bounded artifact and mark it as degraded.
      const summary = degradedSummary(result);
      // Identifiers are best-effort on this path and the request context is bounded, so an
      // identifier that cannot fit must not take the request down with it.
      expect(summary).toContain("## Pending user asks\nLatest user request context:");
      expect(summary).toContain(latestAsk);
      expect(summary).toContain(fittingIdentifier);
      expect(summary).not.toContain(identifier);
      expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
      expect(compactionLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/loss=.*identifier-retention/),
      );
      expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("carries the pending ask and identifiers into the degraded fallback and logs its reasonCode", async () => {
    const latestAsk = "confirm the staging rollback finished";
    const identifier = "/tmp/degraded-retention.log";
    // A summary the audit rejects (no required headings), with facts small enough to fit.
    mockSummarizeInStages.mockResolvedValue("Core summary without headings");

    const { result, sessionManager } = await runTerminalAttempt({
      preparation: { messagesToSummarize: [userMessage(`${latestAsk} ${identifier}`, 1)] },
    });

    // The degrade is lossy on purpose, but the pending request and exact identifiers are
    // the facts worth carrying across a compaction. Finalizing without the retention plan
    // dropped both and stored only the empty fallback template.
    const summary = degradedSummary(result);
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    // Operators and dashboards branch on this marker; pin it so a refactor of the helper's
    // log contract cannot drop it silently.
    expect(compactionLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasonCode=quality_guard_degraded_fallback"),
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps the generated split-turn context when a terminal audit failure trims the degraded suffix", async () => {
    const latestAsk = "roll back the api deployment and confirm health";
    const activeTurn = "Active turn: rolled back api-7 and is waiting on the health check.";
    // Twelve long preserved turns, the file lists and the split-turn summary each fill their
    // own cap, so the degraded suffix alone outgrows the artifact and must be trimmed.
    const files = (kind: string) =>
      Array.from({ length: 40 }, (_, index) => `/srv/app/${kind}/module-${index}.ts`);
    const history = Array.from({ length: 14 }, (_, turn) => [
      userMessage(`turn ${turn} ${"u".repeat(700)}`, 2 * turn + 1),
      castAgentMessage(timestampedTextAssistant(`reply ${turn} ${"r".repeat(700)}`, 2 * turn + 2)),
    ]).flat();
    mockSummarizeInStages
      .mockResolvedValueOnce("Core summary without headings")
      .mockResolvedValueOnce(`${activeTurn} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`);

    const { result } = await runTerminalAttempt({
      recentTurnsPreserve: 12,
      preparation: {
        messagesToSummarize: history,
        turnPrefixMessages: [userMessage(latestAsk, 100)],
        fileOps: { read: files("read"), edited: files("edit"), written: [] },
        isSplitTurn: true,
      },
    });

    const summary = degradedSummary(result);
    // The split-turn summary is the only generated context left on this path. Capping the
    // suffix by its tail dropped it first and kept older verbatim turns instead.
    expect(summary).toContain(`**Turn Context (split turn):**\n\n${activeTurn}`);
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
    expect(summary).toContain("reply 13 ");
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
  });
});
