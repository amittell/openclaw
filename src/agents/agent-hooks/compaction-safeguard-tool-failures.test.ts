/** Tests the Tool Failures section a compaction summary carries for failed tool results. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { jsonResult } from "../tools/common.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

describe("compaction-safeguard tool failures", () => {
<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
  const acceptedDetails = jsonResult({
    status: "accepted",
    childSessionKey: "agent:watcher:subagent:abc",
    runId: "run-123",
    mode: "run",
  }).details;
  const failure = (
    toolCallId: string,
    text: string,
    details?: unknown,
    toolName = "exec",
  ): AgentMessage => ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    timestamp: 1,
    isError: true,
    details,
  });
  it.each([
    {
      name: "accepted spawn exclusion and look-alike failures",
      messages: [
        failure("call-spawn-accepted", "accepted", acceptedDetails, "sessions_spawn"),
        failure("call-exec-failed", "boom", { status: "failed", exitCode: 1 }),
        failure("call-spawn-error", "spawn rejected", { status: "error" }, "sessions_spawn"),
        failure("call-other-lookalike", "real failure", acceptedDetails, "some_other_tool"),
      ],
      ids: ["call-exec-failed", "call-spawn-error", "call-other-lookalike"],
      expected: ["exec (status=failed exitCode=1): boom"],
      firstSummary: undefined,
    },
    {
      name: "deduplication and empty output",
      messages: [
        { ...failure("call-1", "", { exitCode: 2 }), content: [] },
        failure("call-1", "ignored"),
      ],
      ids: ["call-1"],
      expected: ["exec (exitCode=2): failed"],
      firstSummary: undefined,
    },
    {
      name: "bounded failure counts and UTF-16 summaries",
      messages: Array.from({ length: 9 }, (_, idx) =>
        failure(`call-${idx}`, `${"x".repeat(236)}🚀tail-${idx}`),
      ),
      ids: Array.from({ length: 9 }, (_, idx) => `call-${idx}`),
      expected: ["## Tool Failures", "...and 1 more"],
      firstSummary: `${"x".repeat(236)}...`,
    },
  ])("formats tool failures with $name", ({ messages, ids, expected, firstSummary }) => {
    const failures = collectToolFailures(messages);
    expect(failures.map((entry) => entry.toolCallId)).toEqual(ids);
    const section = formatToolFailuresSection(failures);
    for (const text of expected) {
      expect(section).toContain(text);
    }
    if (firstSummary !== undefined) {
      expect(failures[0]?.summary).toBe(firstSummary);
    }
=======
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("excludes accepted sessions_spawn results even when persisted with isError", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-accepted",
        toolName: "sessions_spawn",
        isError: true,
        details: {
          status: "accepted",
          childSessionKey: "agent:watcher:subagent:abc",
          runId: "run-123",
          mode: "run",
        },
        content: [{ type: "text", text: "accepted" }],
        timestamp: Date.now(),
      },
    ];

    expect(collectToolFailures(messages)).toHaveLength(0);
  });

  it("still reports sessions_spawn results that genuinely failed", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-error",
        toolName: "sessions_spawn",
        isError: true,
        details: { status: "error" },
        content: [{ type: "text", text: "spawn rejected" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-spawn-forbidden",
        toolName: "sessions_spawn",
        isError: true,
        details: { status: "forbidden" },
        content: [{ type: "text", text: "not allowed" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "call-spawn-error",
      "call-spawn-forbidden",
    ]);
  });

  it("only excludes the accepted spawn from a mixed batch and reports look-alike non-spawn tools", () => {
    // Build the accepted-spawn details via the production helper so the skip is
    // proven against the real sessions_spawn result shape, not a hand-authored stub.
    const acceptedDetails = jsonResult({
      status: "accepted",
      childSessionKey: "agent:watcher:subagent:abc",
      runId: "run-123",
      mode: "run",
    }).details;
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-spawn-accepted",
        toolName: "sessions_spawn",
        isError: true,
        details: acceptedDetails,
        content: [{ type: "text", text: "accepted" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-exec-failed",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "boom" }],
        timestamp: Date.now(),
      },
      {
        // Same accepted-shaped details on a non-spawn tool must still be reported:
        // the skip is gated on toolName so look-alike payloads are not suppressed.
        role: "toolResult",
        toolCallId: "call-other-lookalike",
        toolName: "some_other_tool",
        isError: true,
        details: acceptedDetails,
        content: [{ type: "text", text: "real failure" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures.map((failure: { toolCallId: string }) => failure.toolCallId)).toEqual([
      "call-exec-failed",
      "call-other-lookalike",
    ]);
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("keeps bounded tool-failure text UTF-16 safe", () => {
    const failures = collectToolFailures([
      {
        role: "toolResult",
        toolCallId: "call-boundary",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: `${"x".repeat(236)}🚀tail` }],
        timestamp: Date.now(),
      },
    ]);

    expect(failures[0]?.summary).toBe(`${"x".repeat(236)}...`);
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
  });
});
