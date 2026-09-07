import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { auditSummaryQuality } from "../agent-hooks/compaction-safeguard-quality.js";
import { setCompactionSafeguardRuntime } from "../agent-hooks/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../agent-hooks/compaction-safeguard.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("AgentSession safeguard persistence budget", () => {
  it("preserves audited facts and accounts for loss before durable reopen and replay", async () => {
    const identifier = "https://deploy.example/required-release-816";
    const latestAsk = `Please report the deployment status for ${identifier}`;
    const generatedSummary = [
      "## Decisions",
      "optional detail ".repeat(1500),
      "## Open TODOs",
      "Verify deployment.",
      "## Constraints/Rules",
      "Preserve exact release identifiers.",
      "## Pending user asks",
      latestAsk,
      "## Exact identifiers",
      identifier,
    ].join("\n");
    expect(generatedSummary.length).toBeGreaterThan(16_000);
    const model = {
      ...testModel,
      api: "compaction-test-api",
      contextWindow: 200_000,
      maxTokens: 32_000,
    };
    const dir = tempDirs.make("compaction-persistence-");
    const scope = {
      agentId: "main",
      sessionId: "sqlite-compaction-persistence-816",
      sessionKey: "agent:main:dashboard:sqlite-compaction-persistence-816",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, {
      sessionFile: formatSqliteSessionFileMarker(scope),
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const sessionManager = SessionManager.open(scope, dir);
    sessionManager.appendMessage({
      role: "user",
      content: `${latestAsk} ${"source context ".repeat(4500)}`,
      timestamp: 1,
    });
    sessionManager.appendMessage({
      ...createAssistant(model, [{ type: "text", text: "Old answer." }]),
      timestamp: 2,
    });
    sessionManager.appendMessage({ role: "user", content: "Continue.", timestamp: 3 });
    setCompactionSafeguardRuntime(sessionManager, {
      model,
      recentTurnsPreserve: 0,
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 1,
    });
    const eventBus = createEventBus();
    const capture = createDiagnosticLogRecordCapture();
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: path.join(dir, "warnings.log"),
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request in compaction test"));
    try {
      const resourceLoader = createResourceLoader();
      const extensions = resourceLoader.getExtensions();
      extensions.extensions.push(
        await loadExtensionFromFactory(
          compactionSafeguardExtension,
          sessionManager.getCwd(),
          eventBus,
          extensions.runtime,
        ),
      );
      streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
        createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: generatedSummary }]),
        ),
      );
      const { session } = await createTestSession({
        model,
        sessionManager,
        resourceLoader,
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 4000, keepRecentTokens: 1 },
          retry: { enabled: false },
        }),
      });

      const result = await session.compact();
      const persisted = sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
      expect(result.summary.length).toBeLessThanOrEqual(16_000);
      expect(persisted).toMatchObject({ summary: result.summary, fromHook: true });
      expect(session.messages).toContainEqual(
        // Replay adds checkpoint provenance around the exact saved summary.
        expect.objectContaining({
          role: "compactionSummary",
          summary: expect.stringContaining(result.summary),
        }),
      );
      const reopenedManager = SessionManager.open(scope, dir);
      const reopenedEntry = reopenedManager
        .getBranch()
        .findLast((entry) => entry.type === "compaction");
      expect(reopenedEntry).toEqual(persisted);
      const savedSummary = reopenedEntry?.summary ?? "";
      expect(
        auditSummaryQuality({
          summary: savedSummary,
          structuralSummary: savedSummary,
          identifiers: [identifier],
          latestAsk,
        }),
      ).toEqual({ ok: true, reasons: [] });
      expect(result.summary).toContain(identifier);
      expect(result.summary).not.toContain("optional detail ".repeat(1500));
      await capture.flush();
      expect(
        capture.records.some((record) =>
          record.message?.includes("finalized artifact truncated; loss=summary-tail"),
        ),
      ).toBe(true);

      const { session: reopenedSession } = await createTestSession({
        model,
        sessionManager: reopenedManager,
      });
      expect(reopenedSession.messages).toContainEqual(
        expect.objectContaining({
          role: "compactionSummary",
          summary: expect.stringContaining(result.summary),
        }),
      );
      const replayedContexts: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        replayedContexts.push(structuredClone(context));
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "Acknowledged." }]),
        );
      });
      await reopenedSession.prompt("Continue with the release verification.");
      expect(replayedContexts.length).toBeGreaterThan(0);
      const replayedText = (replayedContexts[0]?.messages ?? [])
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.map((block) => (block.type === "text" ? block.text : "")),
        )
        .join("\n");
      expect(replayedText).toContain(result.summary);
      expect(replayedText).toContain(identifier);
      expect(network).not.toHaveBeenCalled();
    } finally {
      setCompactionSafeguardRuntime(sessionManager, null);
      await flushLogger();
      capture.cleanup();
      setLoggerOverride(null);
      resetLogger();
      eventBus.clear();
      network.mockRestore();
    }
  });
});
