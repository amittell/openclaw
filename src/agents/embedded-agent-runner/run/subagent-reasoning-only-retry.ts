import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import { MISSING_REPLY_NOTICE_TEXT } from "../../reply-completion.js";
import { hasAttemptTerminalState } from "./attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

// Leaf contract for the subagent reasoning-only exhaustion. The caller passes the
// full terminal-resolution input; only the fields below are read, so this
// module stays a leaf and does not import terminal-resolution.ts (which
// would form a cycle with its value import of this helper).
type SubagentReasoningOnlyInput = {
  runParams: { lane?: string };
  attempt: EmbeddedRunAttemptResult;
  replayState: { hadPotentialSideEffects: boolean };
};

// The bounded reasoning-only retry itself needs no subagent rule: a subagent
// lane resolves to the "result-required" reply expectation, which keeps reply
// recovery open for it (`resolveCommandReplyExpectation`).
//
// An exhausted subagent turn is a provider failure the requester cannot act on.
// Its fallback safety is replay evidence only, so a replay-safe turn is handed to
// the fallback model even when it stopped normally; other lanes keep the shared
// value, which also requires a non-"stop" reason. The retained presentation is
// gated on the shared replay-safe value in the caller; the replay-safe conditions
// are identical, so when the exhausted value holds the retained summary rides along.
export function resolveSubagentReasoningOnlyExhaustion(params: {
  input: SubagentReasoningOnlyInput;
  terminalInterrupted: boolean;
  promptError: unknown;
  terminalAssistantError: boolean;
  incompleteTurnFallbackSafe: boolean;
  terminalToolPresentation: string | undefined;
  availableTerminalToolPresentation: string | undefined;
}): {
  incompleteTurnText: string;
  payloadCount: number;
  incompleteTurnFallbackSafe: boolean;
  terminalToolPresentation: string | undefined;
} {
  const { input } = params;
  const replaySafe =
    !params.terminalInterrupted &&
    !params.promptError &&
    !input.attempt.lastToolError &&
    !hasAttemptTerminalState(input.attempt) &&
    !params.terminalAssistantError &&
    !input.replayState.hadPotentialSideEffects;
  const exhaustedFallbackSafe =
    input.runParams.lane === AGENT_LANE_SUBAGENT ? replaySafe : params.incompleteTurnFallbackSafe;
  return {
    incompleteTurnText: MISSING_REPLY_NOTICE_TEXT,
    payloadCount: 0,
    incompleteTurnFallbackSafe: exhaustedFallbackSafe,
    terminalToolPresentation: exhaustedFallbackSafe
      ? params.availableTerminalToolPresentation
      : params.terminalToolPresentation,
  };
}
