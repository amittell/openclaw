// Core's generated system turns must never become memory-lancedb memories.
import { describe, expect, it } from "vitest";
import { sanitizeForMemoryCapture, shouldCapture } from "../extensions/memory-lancedb/index.js";
import { TOOL_FAILURE_INSTRUCTION } from "../src/agents/tool-outcome-instructions.js";
import { formatSystemTurnPrompt } from "../src/sessions/system-turn-prompt.js";

describe("memory-lancedb capture of core system turns", () => {
  it("rejects the restart recovery turn that formatSystemTurnPrompt builds", () => {
    // The restart recovery body: its "never" and "important"-style wording is
    // what matched the capture triggers on the bots.
    const body =
      "Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on " +
      "tool/model work. The restart did not cancel the user's task. Continue from the " +
      `existing transcript and finish the task. ${TOOL_FAILURE_INSTRUCTION}`;
    const options = { maxChars: 2_000 };
    expect(shouldCapture(sanitizeForMemoryCapture(body), options)).toBe(true);

    const prompt = formatSystemTurnPrompt(body);

    expect(shouldCapture(prompt, options)).toBe(false);
    expect(shouldCapture(sanitizeForMemoryCapture(prompt), options)).toBe(false);
  });
});
