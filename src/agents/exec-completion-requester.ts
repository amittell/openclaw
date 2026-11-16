import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEventRequester } from "../auto-reply/reply/session-event-contract.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { AgentRunChannelContext } from "./command/shared-types.js";

/** The starting turn's requester; its route is the exec's own captured notification route. */
export type ExecCompletionRequester = Omit<SessionEventRequester, "route">;

/**
 * Capture the sender of the turn that builds exec, from the host-owned run context (never tool
 * arguments), so a background command's completion continues under that sender's policy.
 * A senderless turn captures nothing, and its completion stays senderless.
 */
export function resolveExecCompletionRequester(
  context?: Pick<
    AgentRunChannelContext,
    | "chatType"
    | "senderId"
    | "senderE164"
    | "senderName"
    | "senderUsername"
    | "groupSpace"
    | "groupChannel"
  >,
): ExecCompletionRequester | undefined {
  const senderId = normalizeOptionalString(context?.senderId);
  if (!context || !senderId) {
    return undefined;
  }
  return Object.freeze({
    senderId,
    senderE164: normalizeOptionalString(context.senderE164),
    senderName: normalizeOptionalString(context.senderName),
    senderUsername: normalizeOptionalString(context.senderUsername),
    chatType: normalizeChatType(context.chatType),
    groupSpace: normalizeOptionalString(context.groupSpace),
    groupChannel: normalizeOptionalString(context.groupChannel),
  });
}
