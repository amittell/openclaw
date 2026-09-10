import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

function seedSession() {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
  sessionManager.appendMessage({
    ...createAssistant(testModel, [{ type: "text", text: "old answer" }]),
    timestamp: 2,
  });
  sessionManager.appendMessage({ role: "user", content: "latest prompt", timestamp: 3 });
  return sessionManager;
}

function collectCompactionEnds(session: Awaited<ReturnType<typeof createTestSession>>["session"]) {
  const events: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
  session.subscribe((event) => {
    if (event.type === "compaction_end") {
      events.push(event);
    }
  });
  return events;
}

describe("AgentSession compaction commit guards", () => {
  it("retries once when the summarizer stops at its output budget", async () => {
    const sessionManager = seedSession();
    let requests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      const truncated = ++requests === 1;
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "text", text: truncated ? "condensed hist" : "condensed history" }],
          truncated ? "length" : "stop",
        ),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: createAutoCompactionSettings(),
    });

    const result = await session[agentSessionAutomaticCompaction]();

    expect(requests).toBe(2);
    expect(result.summary).toBe("condensed history");
    expect(
      sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
    ).toMatchObject({ summary: "condensed history" });
  });

  it("refuses to commit when the session leaf moves during summarization", async () => {
    const sessionManager = seedSession();
    let concurrentAppendId: string | undefined;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      // A concurrent append lands while the summarizer is in flight.
      concurrentAppendId ??= sessionManager.appendMessage({
        role: "user",
        content: "concurrent append",
        timestamp: 4,
      });
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "condensed history" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 1 },
        retry: { enabled: false },
      }),
    });
    const compactionEnds = collectCompactionEnds(session);

    await expect(session.compact()).rejects.toThrow(/leaf moved/);

    expect(compactionEnds.map((event) => event.outcome)).toEqual([
      { status: "skipped", reason: expect.stringContaining("leaf moved") },
    ]);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    expect(sessionManager.getLeafId()).toBe(concurrentAppendId);
  });
});
