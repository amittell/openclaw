import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage,
  resetSteeredMessageIdsForTest,
  setActiveEmbeddedRun,
  type EmbeddedPiQueueHandle,
} from "./runs.js";

function createHandle(): EmbeddedPiQueueHandle & { queueMessage: ReturnType<typeof vi.fn> } {
  return {
    queueMessage: vi.fn(async () => {}),
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
}

describe("queueEmbeddedPiMessage steering de-duplication", () => {
  beforeEach(() => {
    resetSteeredMessageIdsForTest();
  });

  it("steers a first-time messageId into the running turn", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("session-1", handle);
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun("session-1", handle);
  });

  it("does not re-inject the SAME messageId a second time into the same running turn", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("session-1", handle);
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);
    // Re-dispatched inbound with the identical messageId must be dropped.
    expect(queueEmbeddedPiMessage("session-1", "hello again", "msg-1")).toBe(false);
    expect(handle.queueMessage).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun("session-1", handle);
  });

  it("still steers a genuinely NEW messageId into the same running turn", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("session-1", handle);
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);
    expect(queueEmbeddedPiMessage("session-1", "different", "msg-2")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledTimes(2);
    clearActiveEmbeddedRun("session-1", handle);
  });

  it("allows the same messageId to be steered in a NEW run after the prior run cleared", () => {
    const first = createHandle();
    setActiveEmbeddedRun("session-1", first);
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);
    clearActiveEmbeddedRun("session-1", first);

    const second = createHandle();
    setActiveEmbeddedRun("session-1", second);
    // A fresh run may steer the same messageId (e.g. a legitimately re-queued followup).
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);
    expect(second.queueMessage).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun("session-1", second);
  });

  it("clears the prior run's steering state when an active run is REPLACED", () => {
    const first = createHandle();
    setActiveEmbeddedRun("session-1", first);
    expect(queueEmbeddedPiMessage("session-1", "hello", "msg-1")).toBe(true);

    // Run A is replaced by run B while A is still active (A never cleared).
    const second = createHandle();
    setActiveEmbeddedRun("session-1", second);
    // B must be able to steer the same messageId: A's steering state belongs
    // to A's generation, not to B. Without the reset, B would reject msg-1
    // as a duplicate of A's steering.
    expect(queueEmbeddedPiMessage("session-1", "hello again", "msg-1")).toBe(true);
    expect(second.queueMessage).toHaveBeenCalledTimes(1);
    expect(first.queueMessage).toHaveBeenCalledTimes(1);

    // A's later clear takes the handle-mismatch branch and must not touch
    // B's steering state.
    clearActiveEmbeddedRun("session-1", first);
    expect(queueEmbeddedPiMessage("session-1", "dup", "msg-1")).toBe(false);
    clearActiveEmbeddedRun("session-1", second);

    // After B clears, a new run may steer msg-1 again.
    const third = createHandle();
    setActiveEmbeddedRun("session-1", third);
    expect(queueEmbeddedPiMessage("session-1", "new run", "msg-1")).toBe(true);
    clearActiveEmbeddedRun("session-1", third);
  });

  it("does not de-duplicate when no messageId is provided (backward compatible)", () => {
    const handle = createHandle();
    setActiveEmbeddedRun("session-1", handle);
    expect(queueEmbeddedPiMessage("session-1", "hello")).toBe(true);
    expect(queueEmbeddedPiMessage("session-1", "hello")).toBe(true);
    expect(handle.queueMessage).toHaveBeenCalledTimes(2);
    clearActiveEmbeddedRun("session-1", handle);
  });

  it("scopes the steering de-duplication per session", () => {
    const a = createHandle();
    const b = createHandle();
    setActiveEmbeddedRun("session-a", a);
    setActiveEmbeddedRun("session-b", b);
    expect(queueEmbeddedPiMessage("session-a", "hi", "msg-1")).toBe(true);
    // Same messageId in a different session is independent.
    expect(queueEmbeddedPiMessage("session-b", "hi", "msg-1")).toBe(true);
    expect(a.queueMessage).toHaveBeenCalledTimes(1);
    expect(b.queueMessage).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun("session-a", a);
    clearActiveEmbeddedRun("session-b", b);
  });
});
