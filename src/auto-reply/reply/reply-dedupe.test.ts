import { beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  recordReplyLanded,
  resetReplyDedupe,
  resolveInboundMessageId,
  resolveReplyDedupeKey,
  shouldSuppressReDispatch,
} from "./reply-dedupe.js";

function buildCtx(overrides: Partial<MsgContext> = {}): ReturnType<typeof finalizeInboundContext> {
  return finalizeInboundContext({
    Body: "",
    CommandBody: "",
    CommandSource: "text",
    From: "telegram:111",
    To: "telegram:222",
    ChatType: "direct",
    Provider: "telegram",
    Surface: "telegram",
    CommandAuthorized: false,
    SessionKey: "agent:main:telegram:direct:222",
    ...overrides,
  });
}

describe("reply-dedupe", () => {
  beforeEach(() => {
    resetReplyDedupe();
  });

  it("does not suppress before any reply has landed", () => {
    const inbound = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    expect(shouldSuppressReDispatch(inbound, 2_000)).toBe(false);
  });

  it("suppresses a re-presented inbound (same messageId) after a reply landed", () => {
    const inbound = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    recordReplyLanded(inbound, 5_000);
    // The ingress spool re-presents the SAME messageId after the reply landed.
    const rePresented = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    expect(shouldSuppressReDispatch(rePresented, 6_000)).toBe(true);
  });

  it("does not suppress a NEW messageId even with an older provider timestamp", () => {
    // Telegram timestamps are only second-resolution: a genuinely new message
    // sent while the prior turn is still running can carry an older Timestamp
    // than the landed reply. Identity must win over the timestamp heuristic.
    const landedAt = 5_000;
    const olderInbound = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    recordReplyLanded(olderInbound, landedAt);
    const newInbound = buildCtx({ MessageSid: "19275", Timestamp: 4_999 });
    expect(shouldSuppressReDispatch(newInbound, 6_000)).toBe(false);
  });

  it("does not suppress when the inbound has no provider message id", () => {
    const inbound = buildCtx({ MessageSid: undefined, Timestamp: 1_000 });
    recordReplyLanded(inbound, 5_000);
    // Without an identity there is nothing to correlate a re-presentation to.
    const rePresented = buildCtx({ MessageSid: undefined, Timestamp: 1_000 });
    expect(shouldSuppressReDispatch(rePresented, 6_000)).toBe(false);
  });

  it("does not suppress when the inbound has no timestamp (identity is still sufficient)", () => {
    const inbound = buildCtx({ MessageSid: "19274", Timestamp: undefined });
    recordReplyLanded(inbound, 5_000);
    const rePresented = buildCtx({ MessageSid: "19274", Timestamp: undefined });
    expect(shouldSuppressReDispatch(rePresented, 6_000)).toBe(true);
  });

  it("scopes the record to the session key (different session is not suppressed)", () => {
    const sessionA = buildCtx({
      MessageSid: "19274",
      SessionKey: "agent:main:telegram:direct:A",
    });
    const sessionB = buildCtx({
      MessageSid: "19274",
      SessionKey: "agent:main:telegram:direct:B",
    });
    recordReplyLanded(sessionA, 5_000);
    expect(shouldSuppressReDispatch(sessionA, 6_000)).toBe(true);
    expect(shouldSuppressReDispatch(sessionB, 6_000)).toBe(false);
  });

  it("monotonically keeps the latest landed time for the same session and id", () => {
    const inbound = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    recordReplyLanded(inbound, 5_000);
    // An earlier "landed" stamp must not move the record backwards.
    recordReplyLanded(inbound, 3_000);
    expect(shouldSuppressReDispatch(inbound, 6_000)).toBe(true);
  });

  it("expires the record after the TTL so a late re-presentation is not suppressed", () => {
    const inbound = buildCtx({ MessageSid: "19274", Timestamp: 1_000 });
    const landedAt = 5_000;
    recordReplyLanded(inbound, landedAt);
    const afterTtl = landedAt + 24 * 60 * 60_000 + 1_000;
    expect(shouldSuppressReDispatch(inbound, afterTtl)).toBe(false);
  });

  it("resolves the provider message id from the full/first/last sid aliases", () => {
    expect(resolveInboundMessageId(buildCtx({ MessageSid: "19274" }))).toBe("19274");
    expect(
      resolveInboundMessageId(buildCtx({ MessageSidFull: "full-1", MessageSid: "19274" })),
    ).toBe("full-1");
    expect(resolveInboundMessageId(buildCtx({ MessageSidFirst: "first-1" }))).toBe("first-1");
    expect(resolveInboundMessageId(buildCtx({ MessageSidLast: "last-1" }))).toBe("last-1");
    expect(resolveInboundMessageId(buildCtx({}))).toBe(null);
  });

  it("falls back to the originating peer when no session key is present", () => {
    const noSession = buildCtx({ SessionKey: undefined, To: "telegram:222" });
    expect(resolveReplyDedupeKey(noSession)).toBe("telegram:222");
    const withSession = buildCtx({ SessionKey: "agent:main:telegram:direct:222" });
    expect(resolveReplyDedupeKey(withSession)).toBe("agent:main:telegram:direct:222");
  });
});
