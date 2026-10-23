import type { TelegramDispatchTurn as Turn } from "./bot-message-dispatch.types.js";
import type { LaneDeliveryResult } from "./lane-delivery-text-deliverer.js";

// A final finalized into the preview never reaches deliverReplies, which logs
// new messages, so each final answer records how it settled here.
export function logFinalDeliveryOutcome(turn: Turn, result: LaneDeliveryResult): void {
  const { receipt, messageIds, suppression } = result.deliveryResult;
  const ids = receipt?.platformMessageIds ?? messageIds ?? [];
  turn.runtime.log?.(
    [
      `telegram final delivery outcome=${result.kind}`,
      `chat=${turn.context.chatId}`,
      ids.length > 0 && `message=${ids.join(",")}`,
      suppression && `reason=${suppression.reason}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}
