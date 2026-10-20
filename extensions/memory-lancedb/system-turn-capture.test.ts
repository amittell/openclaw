import { describe, expect, test } from "vitest";
import type { MemorySearchResult } from "./lancedb-store.js";
import { sanitizeForMemoryCapture } from "./memory-capture-sanitization.js";
import {
  cleanMemorySearchResults,
  formatRelevantMemoriesContext,
  shouldCapture,
} from "./memory-policy.js";

// The gateway restart recovery turn the bots stored as a memory. Core sends it
// as a user-role message built with formatSystemTurnPrompt.
const RESTART_RECOVERY_BODY =
  "Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on " +
  "tool/model work. The restart did not cancel the user's task. Continue from the existing " +
  "transcript: check the current state, recover interrupted work, and finish the task " +
  "without asking the user to repeat the request. If a tool failed, say so; never claim " +
  "completion or success.";
const RESTART_RECOVERY_PROMPT = `[System] ${RESTART_RECOVERY_BODY}`;
// Large enough for the whole prompt, as the bots were configured, so the
// length cap cannot be what rejects it.
const options = { maxChars: 2_000 };

function searchResult(id: string, text: string): MemorySearchResult {
  return {
    entry: { id, text, vector: [1, 0], importance: 0.7, category: "fact", createdAt: 1 },
    score: 0.9,
  };
}

describe("OpenClaw system-turn prompts", () => {
  test("are never captured, while the same words from the user still are", () => {
    const timestamped = `[Wed 2026-10-01 03:54 EDT] ${RESTART_RECOVERY_PROMPT}`;
    expect(shouldCapture(RESTART_RECOVERY_BODY, options)).toBe(true);

    expect(shouldCapture(RESTART_RECOVERY_PROMPT, options)).toBe(false);
    expect(shouldCapture(sanitizeForMemoryCapture(timestamped), options)).toBe(false);
  });

  test("captured by earlier versions stay out of recall", () => {
    const stored = searchResult("restart", RESTART_RECOVERY_PROMPT);
    const preference = searchResult("preference", "I prefer dark mode");

    expect(cleanMemorySearchResults([stored, preference])).toEqual([preference]);
    const context = formatRelevantMemoriesContext([
      { category: "fact", text: RESTART_RECOVERY_PROMPT },
      { category: "preference", text: "I prefer dark mode" },
    ]);
    expect(context).toContain("I prefer dark mode");
    expect(context).not.toContain("gateway restart");
  });
});
