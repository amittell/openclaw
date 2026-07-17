import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReplyUsageStateForTest,
  consumeReplyUsageState,
  recordReplyUsageState,
} from "./reply-usage-state.js";

afterEach(() => {
  vi.useRealTimers();
  clearReplyUsageStateForTest();
});

describe("reply usage state handoff", () => {
  it("requires exact run correlation", () => {
    const snapshot = { provider: "openai", model: "gpt-5.5" };

    recordReplyUsageState("run-a", snapshot);

    expect(consumeReplyUsageState()).toBeUndefined();
    expect(consumeReplyUsageState("run-b")).toBeUndefined();
    expect(consumeReplyUsageState("run-a")).toBe(snapshot);
  });

  it("ignores snapshots without a run id", () => {
    recordReplyUsageState(undefined, { provider: "openai" });

    expect(consumeReplyUsageState()).toBeUndefined();
  });

  it("expires snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordReplyUsageState("run-a", { provider: "openai" });

    vi.setSystemTime(5 * 60_000 + 1);

    expect(consumeReplyUsageState("run-a")).toBeUndefined();
  });

  it("evicts the oldest snapshots above the handoff capacity", () => {
    const entryCount = 1_025;
    for (let index = 0; index < entryCount; index += 1) {
      recordReplyUsageState(`run-capacity-${index}`, {
        provider: "openai",
        model: `model-${index}`,
      });
    }

    expect(consumeReplyUsageState("run-capacity-0")).toBeUndefined();
    expect(consumeReplyUsageState("run-capacity-1")?.model).toBe("model-1");
    expect(consumeReplyUsageState(`run-capacity-${entryCount - 1}`)?.model).toBe(
      `model-${entryCount - 1}`,
    );
  });
});
