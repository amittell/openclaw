import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { findCutPoint } from "./compaction.js";

function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextUsage: { state: "available", promptTokens: totalTokens, totalTokens },
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistantText(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: createUsage(0),
    stopReason: "stop",
    timestamp,
  };
}

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
  return {
    ...assistantText("", timestamp),
    content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
    stopReason: "toolUse",
  };
}

function toolResult(id: string, text: string, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function messageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

describe("findCutPoint tool-pair boundaries", () => {
  it("never cuts at a user turn displaced inside an open tool-call batch", () => {
    const entries = [
      { role: "user", content: "start", timestamp: 1 } satisfies AgentMessage,
      assistantText("first reply", 2),
      { role: "user", content: "run it", timestamp: 3 } satisfies AgentMessage,
      assistantToolCall("call-1", 4),
      { role: "user", content: "displaced steering message", timestamp: 5 } satisfies AgentMessage,
      toolResult("call-1", "x".repeat(400), 6),
      assistantText("done", 7),
    ].map((message, index) => messageEntry(message, index));

    // The retained budget lands on the displaced turn at index 4. Cutting there would keep
    // the tool result while summarizing away the call that owns it, so the cut moves past
    // the closed frame instead.
    expect(findCutPoint(entries, 0, entries.length, 102)).toEqual({
      firstKeptEntryIndex: 6,
      turnStartIndex: 4,
      isSplitTurn: true,
    });
  });

  it("still cuts at the user turn that follows a completed tool-call batch", () => {
    const entries = [
      { role: "user", content: "run it", timestamp: 1 } satisfies AgentMessage,
      assistantToolCall("call-1", 2),
      toolResult("call-1", "x".repeat(400), 3),
      { role: "user", content: "next question", timestamp: 4 } satisfies AgentMessage,
      assistantText("done", 5),
    ].map((message, index) => messageEntry(message, index));

    expect(findCutPoint(entries, 0, entries.length, 4)).toEqual({
      firstKeptEntryIndex: 3,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });
});
