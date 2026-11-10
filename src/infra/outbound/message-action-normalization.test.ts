// Covers channel/target inference, legacy target rewrite, target validation,
// and plugin alias-aware message-action normalization.
import { describe, expect, it, vi } from "vitest";
import { normalizeMessageActionInput } from "./message-action-normalization.js";

vi.mock("../../channels/plugins/bootstrap-registry.js", async () => ({
  getBootstrapChannelPlugin: (
    await import("./message-action-runner.test-support.js")
  ).createPinboardMessageActionBootstrapRegistryMock(),
}));

vi.mock("../../utils/message-channel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/message-channel.js")>()),
  isDeliverableMessageChannel: (value: string) => ["workspace", "forum"].includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

describe("normalizeMessageActionInput", () => {
  type NormalizeMessageActionInputCase = {
    input: Parameters<typeof normalizeMessageActionInput>[0];
    expectedFields?: Record<string, unknown>;
    absentFields?: string[];
  };

  it.each([
    {
      input: {
        action: "send",
        args: {
          target: "channel:C1",
          to: "legacy",
          channelId: "legacy-channel",
        },
      },
      expectedFields: { target: "channel:C1", to: "channel:C1" },
      absentFields: ["channelId"],
    },
    {
      input: {
        action: "broadcast",
        args: {},
        toolContext: {
          currentChannelId: "channel:C1",
        },
      },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "unsend",
        args: {
          channel: "imessage",
          messageId: "msg_123",
        },
        toolContext: {
          currentChannelId: "chat_guid:iMessage;+;chat0000",
          currentChannelProvider: "imessage",
        },
      },
      expectedFields: {
        target: "chat_guid:iMessage;+;chat0000",
        to: "chat_guid:iMessage;+;chat0000",
        messageId: "msg_123",
      },
    },
    {
      input: {
        action: "pin",
        args: {
          channel: "pinboard",
          messageId: "om_123",
        },
      },
      expectedFields: { messageId: "om_123" },
      absentFields: ["target", "to"],
    },
    {
      input: {
        action: "poll-vote",
        args: {
          channel: "imessage",
          chatId: 42,
        },
      },
      expectedFields: { target: "chat_id:42", to: "chat_id:42", chatId: 42 },
    },
    ...[
      { messageThreadId: 99 },
      { message_thread_id: 99 },
      { thread_id: "99" },
      { threadId: 99 },
      { threadId: "99", messageThreadId: 99 },
    ].map((threadArgs): NormalizeMessageActionInputCase => ({
      input: { action: "send" as const, args: { target: "channel:C1", ...threadArgs } },
      expectedFields: { threadId: "99" },
    })),
    // Numeric ids join the string target contract instead of reaching a provider reader.
    {
      input: {
        action: "topic-create",
        args: { target: "-1001234567890", channelId: -1009999999999 },
      },
      expectedFields: { target: "-1001234567890", to: "-1001234567890" },
      absentFields: ["channelId"],
    },
    {
      input: { action: "topic-create", args: { channelId: -1009999999999 } },
      expectedFields: { target: "-1009999999999", to: "-1009999999999" },
      absentFields: ["channelId"],
    },
    {
      input: { action: "send", args: { to: -1009999999999 } },
      expectedFields: { to: "-1009999999999" },
    },
    {
      input: { action: "send", args: { target: -1009999999999 } },
      expectedFields: { to: "-1009999999999" },
    },
  ] satisfies NormalizeMessageActionInputCase[])(
    "normalizes message action input for %j",
    ({ input, expectedFields, absentFields }) => {
      const normalized = normalizeMessageActionInput(input);
      if (expectedFields) {
        for (const [field, value] of Object.entries(expectedFields)) {
          expect(normalized[field]).toBe(value);
        }
      }
      for (const field of absentFields ?? []) {
        expect(field in normalized).toBe(false);
      }
    },
  );

  it("does not inject heartbeat sender sentinel as inferred target", () => {
    // The non-deliverable sender sentinel must not become @heartbeat.
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: {},
        toolContext: {
          currentChannelId: "heartbeat",
          currentChannelProvider: "telegram",
        },
      }),
    ).toThrow(/requires a target/);
  });

  it.each(["channel:agent:main:subagent:worker"])(
    "does not infer internal session %s as a message target",
    (currentChannelId) => {
      expect(() =>
        normalizeMessageActionInput({
          action: "send",
          args: { channel: "discord" },
          toolContext: {
            currentChannelId,
            currentChannelProvider: "discord",
          },
        }),
      ).toThrow(/requires a target/);
    },
  );

  it.each([{ name: "an empty targets array", targets: [] }])(
    "does not replace $name with the current conversation",
    ({ targets }) => {
      expect(() =>
        normalizeMessageActionInput({
          action: "read",
          args: { targets },
          toolContext: {
            currentChannelId: "C_CURRENT",
            currentChannelProvider: "workspace",
          },
        }),
      ).toThrow(/requires a target/);
    },
  );

  it.each([{ action: "poll-vote" as const, args: { channel: "imessage", pollId: "poll_123" } }])(
    "throws when $action has only a resource reference and no current target",
    ({ action, args }) => {
      expect(() =>
        normalizeMessageActionInput({
          action,
          args,
        }),
      ).toThrow(/requires a target/);
    },
  );

  it("rejects conflicting canonical and plugin delivery targets", () => {
    expect(() =>
      normalizeMessageActionInput({
        action: "poll-vote",
        args: {
          channel: "imessage",
          target: "chat_guid:iMessage;-;+15550001111",
          chatGuid: "iMessage;-;+15559998888",
        },
      }),
    ).toThrow(/conflicting target and delivery alias/);
  });

  it.each<Record<string, unknown>>([{ channelId: 2 ** 60 }, { to: 1.5 }])(
    "rejects a numeric target that is not an exact id %j",
    (targetArgs) => {
      expect(() =>
        normalizeMessageActionInput({ action: "topic-create", args: targetArgs }),
      ).toThrow(/that is not an exact id/);
    },
  );

  it.each<Record<string, unknown>>([
    { threadId: "42", messageThreadId: "99" },
    { threadId: "42", message_thread_id: "99" },
    { thread_id: "42", messageThreadId: "99" },
    { threadId: null, message_thread_id: "99" },
  ])("rejects conflicting thread id spellings %j", (threadArgs) => {
    expect(() =>
      normalizeMessageActionInput({
        action: "send",
        args: { target: "channel:C1", ...threadArgs },
      }),
    ).toThrow(/conflicting thread id values/);
  });

  it("allows a trusted direct operator to use an opaque resource without a conversation", () => {
    expect(
      normalizeMessageActionInput({
        action: "unpin",
        args: { channel: "pinboard", postId: "post_123" },
        targetAliasSpec: {
          aliases: ["postId", "roomId"],
          deliveryTargetAliases: ["roomId"],
        },
        allowResourceOnly: true,
      }),
    ).toEqual({ channel: "pinboard", postId: "post_123" });
  });
});
