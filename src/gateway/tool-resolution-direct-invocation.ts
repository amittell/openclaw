import type { ChatType } from "../channels/chat-type.js";
import { inferChatTypeFromTarget } from "../infra/outbound/targets.js";

/**
 * A direct invocation is bound to a conversation only by its hints. Report that
 * conversation's kind as outbound targets infer it, so chat-type confinement
 * applies as it does to a turn from there.
 */
export function directInvocationChatType(
  surface: string,
  messageProvider: string | undefined,
  boundChannelId: string | undefined,
): ChatType | undefined {
  return surface === "http" && messageProvider && boundChannelId
    ? inferChatTypeFromTarget({ channel: messageProvider, to: boundChannelId })
    : undefined;
}
