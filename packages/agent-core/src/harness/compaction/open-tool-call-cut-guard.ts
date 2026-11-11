import type { AgentMessage } from "../../types.js";
import {
  createToolCallOccurrenceQueue,
  extractToolCallsFromAssistant,
  extractToolResultId,
} from "../session/tool-result-pairing.js";

/**
 * Keeps compaction cut points out of open tool-call frames. A cut inside a frame would
 * split a call from its results across the summary boundary; the next assistant closes
 * the frame because the provider only produced that message after the frame was
 * completed or repaired.
 *
 * Split out of ./compaction.ts to keep that file within its max-lines budget.
 */
export function createOpenToolCallCutGuard(isCutPoint: (message: AgentMessage) => boolean) {
  const openToolCalls = createToolCallOccurrenceQueue<true>();
  // Only a cut-point message that lands inside an open frame is stored, which is rare,
  // so the reverse walks can reject it without materializing every valid cut point.
  const blockedCutIndices = new Set<number>();
  return {
    /** Observes each message once, in forward order; true when it is an admissible cut. */
    admits(index: number, message: AgentMessage): boolean {
      if (message.role === "assistant") {
        openToolCalls.clear();
        for (const toolCall of extractToolCallsFromAssistant(message)) {
          openToolCalls.add(toolCall.id, true);
        }
      } else if (message.role === "toolResult") {
        const id = extractToolResultId(message);
        if (id) {
          openToolCalls.claim(id);
        }
        return false;
      } else if (openToolCalls.size > 0) {
        if (isCutPoint(message)) {
          blockedCutIndices.add(index);
        }
        return false;
      }
      return isCutPoint(message);
    },
    /** For the reverse walks, after the forward pass has observed every message. */
    allows: (index: number, message: AgentMessage): boolean =>
      isCutPoint(message) && !blockedCutIndices.has(index),
  };
}
