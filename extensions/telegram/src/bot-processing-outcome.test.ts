/** Verifies Telegram update outcomes stay attached to their durable ingress owner. */
import { describe, expect, it } from "vitest";
import {
  ensureTelegramMessageProcessingResult,
  hasTelegramVisibleReplyDelivered,
  markTelegramVisibleReplyDelivered,
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-processing-outcome.js";

describe("Telegram update processing outcomes", () => {
  it("reuses the ingress outcome frame across nested bot middleware", async () => {
    const outer = await runWithTelegramUpdateProcessingFrame(async () => {
      const inner = await runWithTelegramUpdateProcessingFrame(async () => {
        ensureTelegramMessageProcessingResult({ kind: "completed" });
        return "middleware-finished";
      });

      expect(inner).toEqual({ value: "middleware-finished", result: { kind: "completed" } });
      return "update-finished";
    });

    expect(outer).toEqual({ value: "update-finished", result: { kind: "completed" } });
  });

  it.each([
    { kind: "skipped" as const },
    { kind: "failed-retryable" as const, error: new Error("retry") },
  ])(
    "does not replace an explicit $kind disposition with middleware completion",
    async (expected) => {
      const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
        recordTelegramMessageProcessingResult(expected);
        ensureTelegramMessageProcessingResult({ kind: "completed" });
      });

      expect(result).toBe(expected);
    },
  );

  it("keeps deferred owners outcome-free until their participant settles", async () => {
    const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
      await runWithTelegramUpdateProcessingFrame(async () => {});
    });

    expect(result).toBeUndefined();
  });
});

describe("Telegram visible-reply delivery fact", () => {
  it("records delivery on the owning frame and reads it back", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      expect(hasTelegramVisibleReplyDelivered()).toBe(false);
      markTelegramVisibleReplyDelivered();
      expect(hasTelegramVisibleReplyDelivered()).toBe(true);
      return undefined;
    });
  });

  it("shares the fact with nested middleware, which is the ingress owner's frame", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      await runWithTelegramUpdateProcessingFrame(async () => {
        markTelegramVisibleReplyDelivered();
        return undefined;
      });
      // The nested call reuses the outer frame, so a reply sent by inner
      // middleware must still fence the outer attempt's retry decision.
      expect(hasTelegramVisibleReplyDelivered()).toBe(true);
      return undefined;
    });
  });

  it("does not leak between updates", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      markTelegramVisibleReplyDelivered();
      return undefined;
    });
    await runWithTelegramUpdateProcessingFrame(async () => {
      expect(hasTelegramVisibleReplyDelivered()).toBe(false);
      return undefined;
    });
  });

  it("defaults to false with no active frame so an unknown state still retries", () => {
    // False is the safe default: a false negative costs a duplicate reply, a
    // false positive would silently drop the user's message.
    expect(hasTelegramVisibleReplyDelivered()).toBe(false);
    markTelegramVisibleReplyDelivered();
    expect(hasTelegramVisibleReplyDelivered()).toBe(false);
  });
});
