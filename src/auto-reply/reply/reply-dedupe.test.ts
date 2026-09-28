import { beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  recordReplyLanded,
  resetReplyDedupe,
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
    const inbound = buildCtx({ Timestamp: 1_000 });
    expect(shouldSuppressReDispatch(inbound, 2_000)).toBe(false);
  });

  it("suppresses a re-dispatched inbound whose timestamp predates a landed reply", () => {
    const inboundTs = 1_000;
    const landedAt = 5_000;
    const inbound = buildCtx({ Timestamp: inboundTs });
    recordReplyLanded(inbound, landedAt);
    // Re-presented inbound (same message, older ts) arrives after the reply landed.
    expect(shouldSuppressReDispatch(inbound, landedAt + 1_000)).toBe(true);
  });

  it("does not suppress a genuinely newer inbound than the landed reply", () => {
    const landedAt = 5_000;
    const olderInbound = buildCtx({ Timestamp: 1_000 });
    recordReplyLanded(olderInbound, landedAt);
    // A brand-new inbound (ts after the reply) must still process.
    const newerInbound = buildCtx({ Timestamp: 6_000 });
    expect(shouldSuppressReDispatch(newerInbound, 6_500)).toBe(false);
  });

  it("does not suppress when the inbound has no timestamp (cannot prove stale)", () => {
    const landedAt = 5_000;
    const inbound = buildCtx({ Timestamp: undefined });
    recordReplyLanded(inbound, landedAt);
    expect(shouldSuppressReDispatch(inbound, 6_000)).toBe(false);
  });

  it("scopes the record to the session key (different session is not suppressed)", () => {
    const landedAt = 5_000;
    const sessionA = buildCtx({
      Timestamp: 1_000,
      SessionKey: "agent:main:telegram:direct:A",
    });
    const sessionB = buildCtx({
      Timestamp: 1_000,
      SessionKey: "agent:main:telegram:direct:B",
    });
    recordReplyLanded(sessionA, landedAt);
    expect(shouldSuppressReDispatch(sessionA, 6_000)).toBe(true);
    expect(shouldSuppressReDispatch(sessionB, 6_000)).toBe(false);
  });

  it("monotonically keeps the latest landed time for the same session", () => {
    const inbound = buildCtx({ Timestamp: 1_000 });
    recordReplyLanded(inbound, 5_000);
    // An earlier "landed" stamp must not move the record backwards.
    recordReplyLanded(inbound, 3_000);
    expect(shouldSuppressReDispatch(inbound, 6_000)).toBe(true);
  });

  it("falls back to the originating peer when no session key is present", () => {
    const noSession = buildCtx({ SessionKey: undefined, To: "telegram:222" });
    expect(resolveReplyDedupeKey(noSession)).toBe("telegram:222");
    const withSession = buildCtx({ SessionKey: "agent:main:telegram:direct:222" });
    expect(resolveReplyDedupeKey(withSession)).toBe("agent:main:telegram:direct:222");
  });
});
