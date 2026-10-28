// Subagent visibility for one compaction span page. #170712 retired the host's direct subagent
// projection; a durable session answers each source or run lookup through the history worker's
// "inline-visibility" request, and the span's display projection then reads only those facts.
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.types.js";
import type {
  SessionHistorySubagentFacts,
  SessionHistorySubagentLookup,
} from "../../config/sessions/session-history-types.js";
import { projectChatDisplayMessagesWithState } from "../chat-display-projection.core.js";
import { createPreparedSessionHistorySubagentProjection } from "../session-history-delta-visibility.js";
import type { SubagentCoordinationDisplayResolver } from "../session-transcript-read.types.js";

// An answer can change which later messages ask a question; a span settles in a pass or two.
const MAX_SPAN_VISIBILITY_PASSES = 4;

const runKey = (runId: string, messageSeq: number | undefined) =>
  `${runId}\u0000${messageSeq ?? ""}`;

/** Prepares the facts the span's projection asks for; a missing fact fails the read closed. */
export async function prepareCompactionSpanSubagentCoordination(
  target: SessionTranscriptReadScope,
  messages: readonly unknown[],
): Promise<SubagentCoordinationDisplayResolver> {
  const sessions = new Map<string, boolean>();
  const runs = new Map<string, [string, number | undefined, boolean]>();
  const assertions: Array<() => void> = [];
  let failure: SessionHistorySubagentFacts["failure"];
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  for (let pass = 0; pass < MAX_SPAN_VISIBILITY_PASSES && !failure; pass += 1) {
    const missing = new Map<string, SessionHistorySubagentLookup>();
    projectChatDisplayMessagesWithState([...messages], {
      includeCommentaryFallbacks: true,
      subagentCoordination: {
        isSubagentSession: (sessionKey) => {
          const hidden = sessions.get(sessionKey);
          if (hidden === undefined) {
            missing.set(`session:${sessionKey}`, { kind: "session", sessionKey });
          }
          return hidden ?? false;
        },
        isSubagentRunMessage: (runId, messageSeq) => {
          const known = runs.get(runKey(runId, messageSeq));
          if (!known) {
            missing.set(`run:${runKey(runId, messageSeq)}`, { kind: "run", runId, messageSeq });
          }
          return known?.[2] ?? false;
        },
      },
    });
    if (missing.size === 0) {
      break;
    }
    for (const lookup of missing.values()) {
      const prepared = await readSessionHistoryPageInWorker({
        kind: "inline-visibility",
        params: { target, lookup },
      });
      assertions.push(prepared.assertCurrent);
      const facts = prepared.subagentCoordination;
      for (const [sessionKey, hidden] of facts.sessions) {
        sessions.set(sessionKey, hidden);
      }
      for (const [runId, messageSeq, hidden] of facts.runMessages) {
        runs.set(runKey(runId, messageSeq), [runId, messageSeq, hidden]);
      }
      if (facts.failure) {
        failure = facts.failure;
        break;
      }
    }
  }
  return createPreparedSessionHistorySubagentProjection(
    { sessions: [...sessions], runMessages: [...runs.values()], ...(failure ? { failure } : {}) },
    () => {
      for (const assertCurrent of assertions) {
        assertCurrent();
      }
    },
  );
}
