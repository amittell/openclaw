// Covers heartbeat event preview truncation.
// Split out of ./heartbeat-runner.tool-response.test.ts to keep that file within
// the max-lines budget. truncateHeartbeatPreview is a pure helper, so this suite
// needs none of that file's channel-registry harness.
import { describe, expect, it } from "vitest";
import { truncateHeartbeatPreview } from "./heartbeat-runner-prompt.js";

describe("heartbeat event previews", () => {
  it("keeps the 200-code-unit preview UTF-16 well-formed", () => {
    expect(truncateHeartbeatPreview(`${"x".repeat(199)}🚀tail`)).toBe("x".repeat(199));
    expect(truncateHeartbeatPreview(undefined)).toBeUndefined();
  });
});
