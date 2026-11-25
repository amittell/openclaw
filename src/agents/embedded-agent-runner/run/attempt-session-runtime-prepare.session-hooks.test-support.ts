import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi, type Mock } from "vitest";
import { Agent } from "../../runtime/index.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedSessionFixture = {
  activeSession: object;
  agentSession: { trustedLocalMediaToolNames: ReadonlySet<string> };
  sessionManager: { setTrustedLocalMediaToolNames: Mock<(names: ReadonlySet<string>) => void> };
  input: Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];
  prepare: () => Promise<unknown>;
};

// Fork carries: hooks prepareEmbeddedAttemptSessionRuntime installs on the session it prepares.
// The caller's fixture mocks every other preparation stage and records their order.
export function registerPreparedSessionHookTests(createFixture: () => PreparedSessionFixture) {
  describe("trusted local-media handoff", () => {
    it("hands the session manager live delivery's own trusted local-media Set", async () => {
      const fixture = createFixture();

      await fixture.prepare();

      // The guard must hold live delivery's own Set: refreshTools mutates it in place.
      expect(fixture.sessionManager.setTrustedLocalMediaToolNames).toHaveBeenCalledOnce();
      expect(fixture.sessionManager.setTrustedLocalMediaToolNames.mock.calls[0]?.[0]).toBe(
        fixture.agentSession.trustedLocalMediaToolNames,
      );
    });
  });

  describe("tool-free settled-turn finalization", () => {
    const model: Model = {
      id: "test-model",
      name: "Test Model",
      api: "openai-completions",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 1_000,
    };

    function response(content: AssistantMessage["content"]): AssistantMessage {
      return {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: createZeroUsageFixture(),
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
    }

    /** The measured model: it calls an unavailable tool, then answers once told it is missing. */
    async function runPreparedAgentLoop(attempt: Partial<EmbeddedRunAttemptParams>) {
      const responses = [
        response([{ type: "toolCall", id: "call-write", name: "write", arguments: {} }]),
        response([{ type: "text", text: "The final answer." }]),
      ];
      const streamFn = vi.fn(() => {
        const message = responses[Math.min(streamFn.mock.calls.length, responses.length) - 1]!;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
          stream.end();
        });
        return stream;
      });
      const agent = new Agent({ initialState: { model, tools: [] }, streamFn });
      const fixture = createFixture();
      Object.assign(fixture.activeSession, { agent });
      Object.assign(fixture.input.attempt, attempt);
      await prepareEmbeddedAttemptSessionRuntime(fixture.input);
      await agent.prompt("Summarize the settled work.");
      return { agent, streamFn };
    }

    it("ends at the first tool call instead of answering Tool not found with another model call", async () => {
      const { agent, streamFn } = await runPreparedAgentLoop({
        operation: "settled-tool-finalization",
        disableTools: true,
      });

      expect(streamFn).toHaveBeenCalledOnce();
      expect(agent.state.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ]);
    });

    it("keeps answering tool errors in ordinary tools-disabled attempts", async () => {
      const { streamFn } = await runPreparedAgentLoop({ operation: "attempt", disableTools: true });

      expect(streamFn).toHaveBeenCalledTimes(2);
    });
  });
}
