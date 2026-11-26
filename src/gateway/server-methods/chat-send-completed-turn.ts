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
 * It records at most once, and only after the source turn committed: the marker answers
 * re-presentations of a committed row, and an uncommitted turn is still owed (its pending
 * input stays queued), so a `final` without a commit must not mark it answered.
 */
export function bindChatSendCompletedTurn(
  context: Pick<GatewayRequestContext, "logGateway">,
  recorder: Pick<UserTurnTranscriptRecorder, "getPendingInputRequestHash" | "hasPersisted">,
  target: ChatSendCompletedTurnTarget,
): () => void {
  let recorded = false;
  return () => {
    if (recorded || !recorder.hasPersisted()) {
      return;
    }
    recorded = true;
    recordChatSendCompletedTurn({
      ...target,
      logGateway: context.logGateway,
      requestHash: recorder.getPendingInputRequestHash?.(),
    });
  };
}
