/**
 * Pins the fork's degraded-fallback retention at the quality guard's terminal
 * paths: the bounded fallback keeps the pending ask, the identifiers that fit and
 * the split-turn context, and logs the reason code instead of cancelling.
 *
 * Lives beside compaction-safeguard.test.ts rather than inside it: the behaviour
 * is fork-only, and upstream carries no file at this path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import * as compactionModule from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import * as compactionQualityModule from "./compaction-safeguard-quality.js";
import { consumeCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";
import {
  createCompactionEvent,
  createQualityGuardSessionManager,
  expectCompactionResult,
  runCompactionScenario,
  structuredSummary,
  userMessage,
  type CompactionEvent,
} from "./compaction-safeguard.scenario.test-support.js";
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
  return {
    ...actual,
    summarizeCompactionHistory: vi.fn(actual.summarizeCompactionHistory),
  };
});

const mockSummarizeCompactionHistory = vi.mocked(compactionModule.summarizeCompactionHistory);
const actualCompactionQualityModule = await vi.importActual<typeof compactionQualityModule>(
  "./compaction-safeguard-quality.js",
);
const mockAuditSummaryQuality = vi.mocked(compactionQualityModule.auditSummaryQuality);

const { MAX_COMPACTION_SUMMARY_CHARS, CONTEXT_TRUNCATED_MARKER } = testing;

beforeEach(() => {
  mockSummarizeCompactionHistory.mockReset();
  testing.setSummarizeCompactionHistoryForTest(mockSummarizeCompactionHistory);
  mockAuditSummaryQuality.mockImplementation(actualCompactionQualityModule.auditSummaryQuality);
  mockAuditSummaryQuality.mockClear();
  compactionLogger.warn.mockClear();
});

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
  resetPluginRuntimeStateForTest();
});

describe("compaction-safeguard recent-turn preservation", () => {
  it.each([
    { name: "source ask", runOwnedRequest: false },
    { name: "run-owned request", runOwnedRequest: true },
  ])(
    "degrades with the $name when an identifier cannot fit the artifact cap",
    async ({ runOwnedRequest }) => {
      mockSummarizeCompactionHistory.mockReset();
      const latestAsk = "preserve the pending deployment status";
      const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
      const fittingIdentifier = "/var/log/deploy-status.log";
      const oversizedRequiredTail = structuredSummary({ asks: latestAsk, identifiers: identifier });
      mockSummarizeCompactionHistory.mockResolvedValue(oversizedRequiredTail);

      const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
      const event = createCompactionEvent({
        preparation: {
          messagesToSummarize: [
            userMessage(`the status log is ${fittingIdentifier}`, 1),
            userMessage(`${latestAsk} ${identifier}`, 2),
          ],
          // The session owner bounds a run-owned request to 800 chars before it gets here.
          ...(runOwnedRequest ? { latestUnresolvedUserRequest: latestAsk } : {}),
        },
      });

      const { result } = await runCompactionScenario(sessionManager, event);

      // Cancelling here left the session permanently uncompactable: the required facts
      // never shrink, so every later attempt hits the same wall. Both terminal quality
      // paths now commit the same bounded artifact and mark it as degraded.
      expect(result).toMatchObject({
        compaction: { details: { qualityDegraded: true } },
      });
      // Identifiers are best-effort on this path and the request context is bounded, so an
      // identifier that cannot fit must not take the request down with it.
      const summary = expectCompactionResult(result).summary;
      expect(summary).toContain("## Pending user asks\nLatest user request context:");
      expect(summary).toContain(latestAsk);
      expect(summary).toContain(fittingIdentifier);
      expect(summary).not.toContain(identifier);
      expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
      expect(compactionLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/loss=.*identifier-retention/),
      );
      expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(1);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("carries the pending ask and identifiers into the degraded fallback", async () => {
    mockSummarizeCompactionHistory.mockReset();
    const latestAsk = "confirm the staging rollback finished";
    const identifier = "/tmp/degraded-retention.log";
    // A summary the audit rejects (no required headings) so the degrade fires, with facts
    // small enough to fit - unlike the infeasible case above, these CAN be retained.
    mockSummarizeCompactionHistory.mockResolvedValue("Core summary without headings");

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: `${latestAsk} ${identifier}`,
    });

    const { result } = await runCompactionScenario(sessionManager, event);

    // The degrade is lossy on purpose, but the pending request and exact identifiers are
    // the facts worth carrying across a compaction. Finalizing without the retention plan
    // dropped both and stored only the empty fallback template.
    expect(result).toMatchObject({
      compaction: { details: { qualityDegraded: true } },
    });
    const summary = (result as { compaction?: { summary?: string } }).compaction?.summary ?? "";
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("logs the greppable reasonCode when the terminal helper degrades the summary", async () => {
    mockSummarizeCompactionHistory.mockReset();
    const latestAsk = "confirm the staging rollback finished";
    // A summary the audit rejects (no required headings) so the terminal audit path degrades
    // rather than regenerating. qualityGuardMaxRetries: 0 makes the first audit failure final.
    mockSummarizeCompactionHistory.mockResolvedValue("Core summary without headings");

    const sessionManager = createQualityGuardSessionManager({ qualityGuardMaxRetries: 0 });
    const event = createCompactionEvent({
      messageText: latestAsk,
      tokensBefore: 1_500,
    });

    const { result } = await runCompactionScenario(sessionManager, event, { apiKey: "***" });

    // The terminal helper commits the degraded boundary and logs the greppable marker that
    // operators and dashboards branch on. Pinning the exact reasonCode keeps a future refactor
    // of the helper's log contract from silently regressing it.
    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    expect(compactionLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasonCode=quality_guard_degraded_fallback"),
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps the generated split-turn context when a terminal audit failure trims the degraded suffix", async () => {
    mockSummarizeCompactionHistory.mockReset();
    const latestAsk = "roll back the api deployment and confirm health";
    const activeTurn = "Active turn: rolled back api-7 and is waiting on the health check.";
    // qualityGuardMaxRetries: 0 makes the audit rejection below terminal, so the degrade fires
    // on the final-attempt audit path rather than a regeneration retry.
    // Twelve long preserved turns, the file lists and the split-turn summary each fill their
    // own cap, so the degraded suffix alone outgrows the artifact and must be trimmed.
    const files = (kind: string) =>
      Array.from({ length: 40 }, (_, index) => `/srv/app/${kind}/module-${index}.ts`);
    const history = Array.from({ length: 14 }, (_, turn) => [
      userMessage(`turn ${turn} ${"u".repeat(700)}`, 2 * turn + 1),
      castAgentMessage(timestampedTextAssistant(`reply ${turn} ${"r".repeat(700)}`, 2 * turn + 2)),
    ]).flat();
    mockSummarizeCompactionHistory
      .mockResolvedValueOnce("Core summary without headings")
      .mockResolvedValueOnce(`${activeTurn} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`);

    const sessionManager = createQualityGuardSessionManager({
      recentTurnsPreserve: 12,
      qualityGuardMaxRetries: 0,
    });
    const splitTurnEvent = createCompactionEvent({
      preparation: {
        messagesToSummarize: history,
        turnPrefixMessages: [userMessage(latestAsk, 100)],
        isSplitTurn: true,
      },
    });
    // createCompactionEvent pins empty file lists; this scenario needs them to fill their cap.
    const event = {
      ...splitTurnEvent,
      preparation: {
        ...splitTurnEvent.preparation,
        fileOps: { read: files("read"), edited: files("edit"), written: [] },
      },
    } as CompactionEvent;

    const { result } = await runCompactionScenario(sessionManager, event);

    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const summary = expectCompactionResult(result).summary;
    // The split-turn summary is the only generated context left on this path. Capping the
    // suffix by its tail dropped it first and kept older verbatim turns instead.
    expect(summary).toContain(`**Turn Context (split turn):**\n\n${activeTurn}`);
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
    expect(summary).toContain("reply 13 ");
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
  });
});
