import { describe, expect, it } from "vitest";
import { isLikelyContextOverflowError } from "./classify.js";

describe("isLikelyContextOverflowError", () => {
  it("detects Codex promptError wording for a full context window", () => {
    expect(
      isLikelyContextOverflowError(
        "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      ),
    ).toBe(true);
  });

  it("does not mistake LM Studio prompt-template override guidance for overflow", () => {
    expect(
      isLikelyContextOverflowError(
        'Error rendering prompt with jinja template: "Cannot apply filter upper to type UndefinedValue". You can override the prompt template in model settings.',
      ),
    ).toBe(false);
  });

  it("treats Anthropic long-context 429 as context overflow (not rate limit)", () => {
    // Anthropic returns HTTP 429 for this message, but it is semantically a context
    // overflow — the session is too large. It should route to compact+retry, not
    // model fallback.
    expect(isLikelyContextOverflowError("Extra usage is required for long context requests.")).toBe(
      true,
    );
    expect(isLikelyContextOverflowError("extra usage is required for long context requests")).toBe(
      true,
    );
    expect(
      isLikelyContextOverflowError(
        "429 Extra usage is required for long context requests. Please contact support.",
      ),
    ).toBe(true);
    // Standard rate limit messages must still be excluded
    expect(isLikelyContextOverflowError("Rate limit exceeded")).toBe(false);
  });
});
