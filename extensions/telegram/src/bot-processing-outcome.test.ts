/** Fork-only: the visible-reply delivery fact that fences a Telegram update retry. */
import { describe, expect, it } from "vitest";
import {
  captureTelegramVisibleReplyDelivered,
  markTelegramVisibleReplyDelivered,
  runWithTelegramUpdateProcessingFrame,
} from "./bot-processing-outcome.js";

describe("Telegram visible-reply delivery fact", () => {
  it("records delivery on the owning frame and reads it back", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      const hasDelivered = captureTelegramVisibleReplyDelivered();
      expect(hasDelivered()).toBe(false);
      markTelegramVisibleReplyDelivered();
      expect(hasDelivered()).toBe(true);
      return undefined;
    });
  });

  it("shares the fact with nested middleware, which is the ingress owner's frame", async () => {
    await runWithTelegramUpdateProcessingFrame(async () => {
      const hasDelivered = captureTelegramVisibleReplyDelivered();
      await runWithTelegramUpdateProcessingFrame(async () => {
        markTelegramVisibleReplyDelivered();
        return undefined;
      });
      // The nested call reuses the outer frame, so a reply sent by inner
      // middleware must still fence the outer attempt's retry decision.
      expect(hasDelivered()).toBe(true);
      return undefined;
    });
  });

  it("answers for its own update while another update's frame is current", async () => {
    // Settlement runs on the followup drain chain, whose ambient frame belongs to
    // whichever update rooted it. Reading there must not answer for this attempt.
    const captured = await runWithTelegramUpdateProcessingFrame(async () =>
      captureTelegramVisibleReplyDelivered(),
    );
    await runWithTelegramUpdateProcessingFrame(async () => {
      markTelegramVisibleReplyDelivered();
      expect(captured.value()).toBe(false);
      return undefined;
    });
    expect(captured.value()).toBe(false);
  });

  it("stays false for a dispatch captured with no active frame", () => {
    // A false negative costs a duplicate reply; a false positive drops the
    // user's message, so an unknown owner keeps the pre-existing retry.
    const hasDelivered = captureTelegramVisibleReplyDelivered();
    markTelegramVisibleReplyDelivered();
    expect(hasDelivered()).toBe(false);
  });
});
