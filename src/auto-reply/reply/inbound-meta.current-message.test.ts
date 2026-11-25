/**
 * The Telegram "Current message:" block, split out of inbound-meta.test.ts so that
 * file stays under the line cap (the ratchet rejects growth on a file that is
 * already over it). Subject: src/auto-reply/reply/inbound-meta.current-message.ts.
 */
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { projectTelegramCurrentMessageCarrier } from "./inbound-meta.current-message.js";
import { buildInboundUserContextPrefix, refreshActiveGoalContext } from "./inbound-meta.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { collectRuntimeMetadata } from "./queue/delivery-context.js";

// The carrier projection of the inbound user-context prefix, as reply preparation
// (get-reply-run-context.ts) builds it for the separate runtime-context carrier.
function buildCarrierContext(ctx: TemplateContext): string {
  return projectTelegramCurrentMessageCarrier(
    buildInboundUserContextPrefix(ctx, { timezone: "utc" }),
    ctx,
  );
}

describe("projectTelegramCurrentMessageCarrier — Telegram current-message carrier", () => {
  it("states the current message body inside the Telegram current-message block", () => {
    const body = "What's the end result?";
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToBody: "The full message should not be preferred.",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Timestamp: Date.UTC(2026, 4, 10, 17, 8),
      agentText: body,
      Body: body,
      BodyForAgent: body,
    } as TemplateContext);

    // The carrier is separate from the live user body. Check that this block
    // contains both the quoted reply target and the canonical current body.
    // This assertion checks the projected text, not the model's response.
    expect(text).toContain(`Current message:\n[Replying to: "selected quote"]\n#34974: ${body}`);
    const currentMessageBlock = text.split("Current message:").at(-1) ?? "";
    expect(currentMessageBlock.trimEnd().endsWith("#34974:")).toBe(false);
  });
  it("preserves the bare Telegram current-message header when the turn has no body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974:');
    expect(text.trimEnd().endsWith("#34974:")).toBe(true);
  });

  it("states the current body without a header when the Telegram turn has no message id", () => {
    // Before the carrier fix this block rendered as quote-only: no header line and
    // no body. The body now stands where the header would be, so a turn without a
    // message id is still self-contained rather than silently bodyless.
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      Body: "ship it",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\nship it');
    expect(text).not.toMatch(/#\S*:/);
  });

  it("prefers agentText and collapses whitespace for the Telegram current-message body", () => {
    const text = buildCarrierContext({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      ChatType: "group",
      MessageSid: "34974",
      ReplyToId: "34971",
      ReplyToQuoteText: " selected quote\n",
      SenderName: "obviyus",
      agentText: "agent\n\n  text",
      BodyForAgent: "body for agent",
      Body: "raw body",
    } as TemplateContext);

    expect(text).toContain('Current message:\n[Replying to: "selected quote"]\n#34974: agent text');
    expect(text).not.toContain("body for agent");
    expect(text).not.toContain("raw body");
  });
});

// Version-3 sessions send carrierText as the separate carrier (see
// attempt-prompt-context.test.ts); a queued turn must not lose it on the way.
describe("Telegram carrier text through queued-turn transformations", () => {
  it("keeps each source's carrier rendering in a collected turn", () => {
    const quoted = createQueueTestRun({ prompt: "ship it" });
    quoted.currentInboundContext = {
      text: "Current message:\n#19452:",
      carrierText: "Current message:\n#19452: ship it",
      promptJoiner: " ",
    };
    const plain = createQueueTestRun({ prompt: "and the docs" });
    plain.currentInboundContext = { text: "Conversation info: channel=telegram" };

    expect(collectRuntimeMetadata([quoted, plain]).currentInboundContext).toMatchObject({
      text: "Queued #1 context:\nCurrent message:\n#19452:\n\nQueued #2 context:\nConversation info: channel=telegram",
      carrierText:
        "Queued #1 context:\nCurrent message:\n#19452: ship it\n\nQueued #2 context:\nConversation info: channel=telegram",
    });
  });

  it("refreshes the goal line in the carrier text as in the legacy text", () => {
    const goal = "Active goal: ship the release";
    const refreshed = refreshActiveGoalContext(
      {
        text: `${goal}\n\nCurrent message:\n#19452:`,
        carrierText: `${goal}\n\nCurrent message:\n#19452: ship it`,
        promptJoiner: " ",
        injectedGoalContexts: [goal],
      },
      { sessionId: "goal-complete", updatedAt: 1 },
    );

    expect(refreshed).toMatchObject({
      text: "Current message:\n#19452:",
      carrierText: "Current message:\n#19452: ship it",
    });
  });
});
