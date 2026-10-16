import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { recordChatSendCompletedTurn } from "./chat-send-reply-finalization.js";
import type { GatewayRequestContext } from "./types.js";

type ChatSendCompletedTurnTarget = Omit<
  Parameters<typeof recordChatSendCompletedTurn>[0],
  "logGateway" | "requestHash"
>;

/**
 * Binds chat.send's answered-turn marker for the dispatched-reply finalizer, which
 * invokes it only once the turn reaches `final`; the pending-input hash is read then.
 */
export function bindChatSendCompletedTurn(
  context: Pick<GatewayRequestContext, "logGateway">,
  recorder: Pick<UserTurnTranscriptRecorder, "getPendingInputRequestHash">,
  target: ChatSendCompletedTurnTarget,
): () => void {
  return () =>
    recordChatSendCompletedTurn({
      ...target,
      logGateway: context.logGateway,
      requestHash: recorder.getPendingInputRequestHash?.(),
    });
}
