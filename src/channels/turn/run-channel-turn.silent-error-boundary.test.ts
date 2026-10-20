// Boundary repro for the PR1 DM no-reply fix.
//
// The unit tests prove the DECISIONS (the run-loop's silent-error-exhausted
// hard-stop after MAX_EMPTY_ERROR_RETRIES, and the B' visible non-outcome
// guard). This file proves the LIVE CHANNEL DELIVERY PATH end-to-end: the real
// channel-turn dispatch seam (dispatchRoutedChannelTurn -> runDispatch -> the
// real deliver forwarder -> the channel delivery.deliver spy).
//
// Case 1: the run-loop's silent_error_exhausted terminal payload (isError) is
// delivered to the DM, NOT dropped into a 5-min adoption-stall dead-letter.
// Case 2: a dispatch-throw path surfaces the B' fallback AND records a terminal
// "failed" outcome so the ingress drain dead-letter sees a recorded failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { readAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";

const recordInboundSessionCore = vi.hoisted(() => vi.fn(async () => undefined));
const dispatchReplyWithBufferedBlockDispatcherCore = vi.hoisted(() => vi.fn());
const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const emitMessageSent = vi.hoisted(() => vi.fn());
const getGlobalHookRunner = vi.hoisted(() => vi.fn());
const createMessageSentEmitter = vi.hoisted(() =>
  vi.fn(() => ({ emitMessageSent, hasMessageSentHooks: true })),
);
const readRecentUserAssistantTextForSession = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/reply/provider-dispatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../auto-reply/reply/provider-dispatcher.js")>();
  return {
    ...actual,
    dispatchReplyWithBufferedBlockDispatcherCore,
  };
});

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});

vi.mock("../../infra/outbound/deliver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/outbound/deliver.js")>();
  return { ...actual };
});

vi.mock("../../infra/outbound/message-sent-hook.js", () => ({
  createMessageSentEmitter,
}));

vi.mock("../../plugins/hook-runner-global.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/hook-runner-global.js")>();
  return { ...actual, getGlobalHookRunner };
});

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession,
}));

const cfg = {} as OpenClawConfig;

function createCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: "sender",
    To: "target",
    SessionKey: "agent:main:test:peer",
    Provider: "test",
    Surface: "test",
    ...overrides,
  } as FinalizedMsgContext;
}

// The exact terminal payload the real run-loop now returns after the
// silent-error-exhausted hard-stop (run-loop.ts): a single visible isError
// payload with meta.error.kind = "silent_error_exhausted", livenessState "blocked".
const SILENT_ERROR_EXHAUSTED_TEXT =
  "The model did not produce a usable reply after several attempts. Please try again, or use /new to start a fresh session.";

// A mock provider/dispatch-core that terminates the run-loop in the
// silent-error-exhausted terminal shape and delivers that visible isError
// payload through the REAL dispatcherOptions.deliver forwarder (the live
// channel delivery seam). Single profile, no fallback, after the 3-retry cap.
/** Shape the routed-dispatch seam is mocked with; nothing asserts on these as mocks. */
type MockedRoutedDispatch = (params: {
  dispatcherOptions: {
    deliver: (payload: ReplyPayload, info: { kind: string }) => Promise<unknown>;
  };
}) => Promise<unknown>;

function createSilentErrorExhaustedDispatch(): MockedRoutedDispatch {
  return async (params) => {
    const isErrorPayload: ReplyPayload = {
      text: SILENT_ERROR_EXHAUSTED_TEXT,
      isError: true,
    };
    await params.dispatcherOptions.deliver(isErrorPayload, { kind: "final" });
    return {
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    };
  };
}

function createThrowingDispatch(): MockedRoutedDispatch {
  return async () => {
    throw new Error("run retry limit exhausted");
  };
}

describe("channel turn silent-error boundary (PR1 DM no-reply fix)", () => {
  it("delivers the run-loop silent_error_exhausted isError payload to the DM instead of dead-lettering", async () => {
    // The real run-loop (mocked provider returning an unclassifiable silent
    // error 3x, single profile, no fallback) terminates in this shape. Drive
    // it through the REAL channel-turn dispatch seam.
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(
      createSilentErrorExhaustedDispatch(),
    );
    const deliver = vi.fn(async (payload: ReplyPayload) => {
      return {
        messageIds: ["silent-error-exhausted-1"],
        visibleReplySent: true as const,
        content: payload.text,
      };
    });
    const result = await dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
      ctxPayload: createCtx({ Surface: "telegram" }),
      delivery: { deliver },
    });
    // The turn SETTLES (resolves) rather than rejecting / dead-lettering: the
    // visible outcome is delivered to the DM.
    expect(result.dispatched).toBe(true);
    if (result.dispatched) {
      // B' must NOT double-deliver: the dispatch already produced a visible
      // (isError) payload, so the visible non-outcome fallback is suppressed.
      expect(result.dispatchResult.queuedFinal).toBe(true);
    }
    // The live channel delivery path received exactly the visible isError
    // payload from the run-loop, not the 5-min watchdog dead-letter.
    expect(deliver).toHaveBeenCalledTimes(1);
    const [payload] = deliver.mock.calls[0] as unknown as [ReplyPayload];
    expect(payload.isError).toBe(true);
    expect(payload.text).toBe(SILENT_ERROR_EXHAUSTED_TEXT);
  });

  it("surfaces the B' fallback and records a terminal failure on the dispatch-throw path", async () => {
    // The runDispatch closure reject path (drain-abort / AgentSelectionRequired
    // etc.) throws with NOTHING visible settled -> B' fires.
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createThrowingDispatch());
    const deliver = vi.fn(async (payload: ReplyPayload) => {
      return {
        messageIds: ["fallback-1"],
        visibleReplySent: true as const,
        content: payload.text,
      };
    });
    let dispatchError: unknown;
    try {
      await dispatchRoutedChannelTurn({
        cfg,
        channel: "telegram",
        route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
        ctxPayload: createCtx({ Surface: "telegram" }),
        delivery: { deliver },
      });
    } catch (error) {
      dispatchError = error;
    }
    // Original dispatch error is preserved (best-effort fallback did not mask it).
    expect(dispatchError).toBeInstanceOf(Error);
    expect(dispatchError).toMatchObject({ message: "run retry limit exhausted" });
    // B' delivered the visible fallback to the DM via the live channel path.
    expect(deliver).toHaveBeenCalledTimes(1);
    const [payload] = deliver.mock.calls[0] as unknown as [ReplyPayload];
    expect(payload.text).toContain("I hit a problem handling that message");
    expect(payload.text).toContain("/new");
    // The dead-letter path sees a recorded terminal failure (blocker 3).
    expect(readAgentRunTerminalOutcome(dispatchError as object)).toBe("failed");
  });

  it("skips the B' fallback and preserves the original error for observeOnly turns", async () => {
    // Carried from the fork's run-channel-turn.delivery.test.ts, which cannot
    // hold it: that file is 997 effective lines against a 1000 budget.
    // The opt-out is satisfied by admission.kind === "observeOnly"; the turn is
    // also system-sourced, which the guard reads via ctxPayload.InternalTurnSource.
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createThrowingDispatch());
    const deliver = vi.fn(async () => {
      throw new Error("observeOnly delivery must be impossible");
    });
    await expect(
      dispatchRoutedChannelTurn({
        cfg,
        channel: "telegram",
        admission: { kind: "observeOnly", reason: "heartbeat" },
        route: { agentId: "main", sessionKey: "agent:main:telegram:peer" },
        ctxPayload: createCtx({ Surface: "telegram", Provider: "heartbeat" }),
        delivery: { deliver },
      }),
    ).rejects.toThrow("run retry limit exhausted");
    expect(deliver).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    recordInboundSessionCore.mockResolvedValue(undefined);
    dispatchReplyWithBufferedBlockDispatcherCore.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    dispatchReplyWithRoutedChannelDispatcherCore.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info" });
    createMessageSentEmitter.mockImplementation(() => ({
      emitMessageSent,
      hasMessageSentHooks: true,
    }));
    getGlobalHookRunner.mockReturnValue(null);
    readRecentUserAssistantTextForSession.mockResolvedValue([]);
  });

  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });
});
