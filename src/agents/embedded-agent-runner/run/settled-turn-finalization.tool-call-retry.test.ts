// The rh-bot shape: a tools-disabled finalization pass calls a tool anyway.
// Each pass below is a real agent loop with no tools and the first-tool-call
// stop, judged by the real result projection, inside the real finalization loop.
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import { projectSettledTurnFinalizationAttemptResult } from "../../harness/settled-turn-finalization-result.js";
import { Agent } from "../../runtime/index.js";
import { makeEmbeddedRunnerAttempt } from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { SETTLED_FINALIZATION_TOOL_CALL_RETRY_INSTRUCTION } from "./incomplete-turn-recovery.js";
import { installSettledFinalizationToolCallStop } from "./settled-finalization-tool-stop.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import {
  createSettledFinalizationTestInput,
  createSettledProviderFailureAttempt,
} from "./settled-turn-finalization.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const backendMocks = vi.hoisted(() => ({ runSettledFinalization: vi.fn() }));

vi.mock("./backend.js", () => ({
  resolveRuntimeModelAttempt: () => undefined,
  runEmbeddedSettledTurnFinalizationWithBackend: backendMocks.runSettledFinalization,
}));
vi.mock("../../../plugin-sdk/session-transcript-runtime.js", () => ({
  appendAssistantMirrorMessageByIdentity: vi.fn(),
}));
vi.mock("../../run-session-target.js", () => ({
  resolveAgentRunSessionTarget: vi.fn(async (params: { sessionId: string }) => ({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: "agent:main:settled",
    storePath: "/synthetic/sessions.json",
  })),
}));

const FALLBACK_TEXT =
  "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
const answer = "The note is saved and the report is complete.";

const model: Model = {
  id: "qwen3.8-27b",
  name: "qwen3.8-27b",
  api: "openai-completions",
  provider: "gpufarm",
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

const callTool = (name: string) =>
  response([{ type: "toolCall", id: `call-${name}`, name, arguments: {} }]);
const say = (text: string) => response([{ type: "text", text }]);

type Pass = { prompt: string; modelCalls: number; roles: string[]; toolResultText?: string };

/** Each script is one finalization pass; its later responses would only be used if re-prompted. */
function scriptFinalizationPasses(scripts: AssistantMessage[][]) {
  const passes: Pass[] = [];
  backendMocks.runSettledFinalization.mockImplementation(
    async (attempt: EmbeddedRunAttemptParams) => {
      const script = scripts[passes.length] ?? [say("unexpected extra pass")];
      const streamFn = vi.fn(() => {
        const message = script[Math.min(streamFn.mock.calls.length, script.length) - 1]!;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
          stream.end();
        });
        return stream;
      });
      const agent = new Agent({ initialState: { model, tools: [] }, streamFn });
      installSettledFinalizationToolCallStop(agent, {
        operation: "settled-tool-finalization",
        disableTools: true,
        runId: attempt.runId,
      });
      await agent.prompt(attempt.prompt);
      const messages = agent.state.messages;
      const final = messages.findLast((message) => message.role === "assistant");
      const rejected = messages.flatMap((message) =>
        message.role === "toolResult" ? [message] : [],
      );
      const toolResultText = rejected.at(-1)?.content.find((block) => block.type === "text");
      passes.push({
        prompt: attempt.prompt,
        modelCalls: streamFn.mock.calls.length,
        roles: messages.map((message) => message.role),
        ...(toolResultText?.type === "text" ? { toolResultText: toolResultText.text } : {}),
      });
      // The evidence the subscriber records for calls rejected before execution.
      const result = projectSettledTurnFinalizationAttemptResult(
        makeEmbeddedRunnerAttempt({
          messagesSnapshot: messages,
          lastAssistant: final?.role === "assistant" ? final : undefined,
          currentAttemptAssistant: final?.role === "assistant" ? final : undefined,
          currentAttemptCompletedAssistant: final?.role === "assistant" ? final : undefined,
          toolMetas: rejected.map((message) => ({
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            isError: message.isError,
          })),
          ...(rejected.length > 0
            ? {
                lastToolError: {
                  toolName: rejected.at(-1)!.toolName,
                  executionStarted: false,
                  error: toolResultText?.type === "text" ? toolResultText.text : "",
                },
              }
            : {}),
          itemLifecycle: {
            startedCount: rejected.length,
            completedCount: rejected.length,
            activeCount: 0,
          },
          replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
          currentAttemptReplayMetadata: {
            hadPotentialSideEffects: rejected.length > 0,
            replaySafe: rejected.length === 0,
          },
        }),
      );
      return { outcome: "answered", result };
    },
  );
  return passes;
}

let admittedRunContext: AdmittedRunContext;

function rhBotFinalizationInput() {
  const input = createSettledFinalizationTestInput(
    createSettledProviderFailureAttempt(),
    admittedRunContext,
  );
  input.terminalBase.runParams.trigger = "user";
  input.terminalBase.runParams.sourceReplyDeliveryMode = undefined;
  input.finalization.modelApi = "openai-completions";
  return input;
}

describe("tool-free finalization after a stopped tool call", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "tool-call-retry-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => {
    admission.close();
  });

  it("accepts the clean answer from the one extra tools-off attempt", async () => {
    const passes = scriptFinalizationPasses([
      [callTool("write"), say("An answer the stop must never request.")],
      [say(answer)],
    ]);

    const result = await prepareTerminalWithSettledTurnFinalization(rhBotFinalizationInput());

    expect(passes.map((pass) => pass.modelCalls)).toEqual([1, 1]);
    expect(passes[0]?.roles).toEqual(["user", "assistant", "toolResult"]);
    expect(passes[0]?.toolResultText).toBe("Tool write not found");
    expect(passes[0]?.prompt).not.toContain(SETTLED_FINALIZATION_TOOL_CALL_RETRY_INSTRUCTION);
    expect(passes[1]?.prompt).toContain(SETTLED_FINALIZATION_TOOL_CALL_RETRY_INSTRUCTION);
    expect(result.finalizationOutcome).toBe("answered");
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: answer }),
    ]);
  });

  it("ends with the original fallback when the extra attempt calls a tool again", async () => {
    const passes = scriptFinalizationPasses([
      [callTool("write"), say("An answer the stop must never request.")],
      [callTool("exec"), say("An answer the stop must never request.")],
      [say("A third pass must never run.")],
    ]);

    const result = await prepareTerminalWithSettledTurnFinalization(rhBotFinalizationInput());

    expect(passes.map((pass) => pass.modelCalls)).toEqual([1, 1]);
    expect(backendMocks.runSettledFinalization).toHaveBeenCalledTimes(2);
    expect(result.prepared.payloadsWithToolMedia).toEqual([
      expect.objectContaining({ text: FALLBACK_TEXT }),
    ]);
  });
});
