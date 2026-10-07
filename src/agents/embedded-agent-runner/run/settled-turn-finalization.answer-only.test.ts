// A response that spends its whole output budget on reasoning gets one
// tools-disabled, low-reasoning answer pass, even after side effects made the
// ordinary reasoning-only retry unsafe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  prepareSystemAgentRunAdmission,
  type AdmittedRunContext,
} from "../../admitted-run-context.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { prepareTerminalWithSettledTurnFinalization } from "./settled-turn-finalization.js";
import { createSettledFinalizationTestInput } from "./settled-turn-finalization.test-support.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const backendMocks = vi.hoisted(() => ({
  runSettledFinalization: vi.fn(),
}));

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

const provider = "gpufarm";
const model = "qwen3.8-27b";
const answer = "Here is the answer the reasoning was building toward.";

function reasoningOnlyLengthStop(content = [{ type: "thinking" as const, thinking: "..." }]) {
  return buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider,
    model,
    stopReason: "length",
    content,
  });
}

/** The measured shape: earlier tools made the run replay-unsafe, then reasoning hit the cap. */
function lengthStoppedAttempt(options: {
  settledToolsInThisAttempt: boolean;
  replaySafe?: boolean;
  final?: ReturnType<typeof reasoningOnlyLengthStop>;
}): EmbeddedRunAttemptWithReceiptEvidence {
  const final = options.final ?? reasoningOnlyLengthStop();
  const user = { role: "user" as const, content: "Investigate and report", timestamp: 0 };
  const toolCall = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider,
    model,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call-write", name: "write", arguments: {} }],
  });
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: "session-settled",
    messagesSnapshot: options.settledToolsInThisAttempt
      ? [user, toolCall, makeTextToolResult("call-write", "write", "Saved", false, 1), final]
      : [user, final],
    toolMetas: options.settledToolsInThisAttempt
      ? [{ toolCallId: "call-write", toolName: "write", isError: false, replaySafe: false }]
      : [],
    itemLifecycle: options.settledToolsInThisAttempt
      ? { startedCount: 1, completedCount: 1, activeCount: 0 }
      : { startedCount: 0, completedCount: 0, activeCount: 0 },
    replayMetadata: options.replaySafe
      ? { hadPotentialSideEffects: false, replaySafe: true }
      : { hadPotentialSideEffects: true, replaySafe: false },
    lastAssistant: final,
    currentAttemptAssistant: final,
    currentAttemptCompletedAssistant: final,
  });
}

let admittedRunContext: AdmittedRunContext;

function answerOnlyInput(
  attempt: EmbeddedRunAttemptWithReceiptEvidence,
  thinkLevel: EmbeddedRunAttemptParams["thinkLevel"] = "xhigh",
) {
  const input = createSettledFinalizationTestInput(attempt, admittedRunContext);
  input.terminalBase.runParams.trigger = "user";
  input.terminalBase.runParams.sourceReplyDeliveryMode = undefined;
  input.terminalBase.activeErrorContext = { provider, model };
  input.finalization.modelApi = "openai-completions";
  input.finalization.preparedAttempt.thinkLevel = thinkLevel;
  return input;
}

async function resolveTerminalAfterFinalization(
  input: ReturnType<typeof answerOnlyInput>,
  result: Awaited<ReturnType<typeof prepareTerminalWithSettledTurnFinalization>>,
) {
  const terminalInput = makeTerminalInput({
    ...result.prepared,
    attempt: result.attempt,
    attemptAssistant: result.attemptAssistant,
    terminalState: result.terminalState,
    runParams: input.terminalBase.runParams,
    activeErrorContext: { provider, model },
    modelApi: "openai-completions",
    settledTurnFinalizationOutcome: result.finalizationOutcome,
    replayState: {
      hadPotentialSideEffects: !result.attempt.replayMetadata.replaySafe,
      replayInvalid: false,
    },
  });
  const terminal = await resolveEmbeddedRunTerminal(terminalInput);
  if (terminal.action !== "complete") {
    throw new Error("expected the terminal to complete without another retry");
  }
  expect(terminalInput.activateInternalPrompt).not.toHaveBeenCalled();
  return terminal.result;
}

describe("answer-only finalization after a reasoning-exhausted response", () => {
  let admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
  beforeEach(async () => {
    backendMocks.runSettledFinalization.mockReset();
    admission = prepareSystemAgentRunAdmission({}, "run-settled", "main", "answer-only-test");
    admittedRunContext = await admission.admit("embedded");
  });
  afterEach(() => {
    admission.close();
  });

  it.each([
    { settledToolsInThisAttempt: false, replaySafe: false, thinkLevel: "xhigh" as const },
    { settledToolsInThisAttempt: true, replaySafe: false, thinkLevel: "xhigh" as const },
    // Also replaces the ordinary reasoning-only retries; "off" evidently did not hold.
    { settledToolsInThisAttempt: false, replaySafe: true, thinkLevel: "off" as const },
  ])(
    "answers once with tools disabled and low reasoning (settled tools: $settledToolsInThisAttempt, replay-safe: $replaySafe, thinking: $thinkLevel)",
    async ({ settledToolsInThisAttempt, replaySafe, thinkLevel }) => {
      const attempt = lengthStoppedAttempt({ settledToolsInThisAttempt, replaySafe });
      backendMocks.runSettledFinalization.mockResolvedValueOnce({
        outcome: "answered",
        result: {
          assistant: buildEmbeddedRunnerAssistant({ content: [{ type: "text", text: answer }] }),
        },
      });
      const input = answerOnlyInput(attempt, thinkLevel);

      const result = await prepareTerminalWithSettledTurnFinalization(input);

      expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
      const [finalizationAttempt] = backendMocks.runSettledFinalization.mock.calls[0] ?? [];
      expect(finalizationAttempt).toMatchObject({
        operation: "settled-tool-finalization",
        disableTools: true,
        thinkLevel: "low",
      });
      expect((finalizationAttempt as EmbeddedRunAttemptParams).prompt).toContain(
        "used its whole output budget on reasoning",
      );
      expect(result.finalizationOutcome).toBe("answered");
      const terminal = await resolveTerminalAfterFinalization(input, result);
      expect(terminal.meta.error).toBeUndefined();
      expect(terminal.payloads).toEqual([expect.objectContaining({ text: answer })]);
    },
  );

  it("keeps the incomplete-turn error when the single answer-only pass is empty", async () => {
    const attempt = lengthStoppedAttempt({ settledToolsInThisAttempt: false });
    backendMocks.runSettledFinalization.mockResolvedValue({
      outcome: "empty",
      result: { assistant: buildEmbeddedRunnerAssistant({ content: [] }) },
    });
    const input = answerOnlyInput(attempt);

    const result = await prepareTerminalWithSettledTurnFinalization(input);

    expect(backendMocks.runSettledFinalization).toHaveBeenCalledOnce();
    expect(result.finalizationOutcome).toBe("failed");
    const terminal = await resolveTerminalAfterFinalization(input, result);
    expect(terminal.meta.error?.kind).toBe("incomplete_turn");
    expect(terminal.payloads).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("couldn't generate a response"),
        isError: true,
      }),
    ]);
  });

  it.each([
    {
      name: "visible partial text",
      content: [
        { type: "thinking" as const, thinking: "..." },
        { type: "text" as const, text: "Partial answer" },
      ],
      assistantTexts: ["Partial answer"],
    },
    {
      name: "a tool call",
      content: [
        { type: "thinking" as const, thinking: "..." },
        { type: "toolCall" as const, id: "call-late", name: "read", arguments: {} },
      ],
      assistantTexts: [],
    },
  ])("leaves a length stop with $name to its existing owner", async (shape) => {
    const final = buildEmbeddedRunnerAssistant({
      api: "openai-completions",
      provider,
      model,
      stopReason: "length",
      content: shape.content,
    });
    const attempt = lengthStoppedAttempt({ settledToolsInThisAttempt: false, final });
    attempt.assistantTexts = shape.assistantTexts;

    const result = await prepareTerminalWithSettledTurnFinalization(answerOnlyInput(attempt));

    expect(backendMocks.runSettledFinalization).not.toHaveBeenCalled();
    expect(result.finalizationOutcome).toBe("not-attempted");
  });
});
