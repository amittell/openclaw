/** Outbound send-suppression bookkeeping for the message tool.
 *
 * Split out of ./message-tool-execution.ts to keep that file within the
 * max-lines budget. Holds the module-scoped poll-vote-echo and duplicate-send
 * state plus the shared route resolver that keys both; nothing here is imported
 * outside ./message-tool-execution.ts, so no re-export is needed.
 */
import { normalizeOptionalStringifiedId } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

export const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Keyed by agent session (conversation), NOT per message-tool instance: a native
// poll and its accompanying comment arrive as separate inbound messages and are
// processed in separate agent runs, each with a fresh tool instance. An
// instance-local record would be lost before the follow-up text run, so the echo
// (the agent restating its vote in prose) would leak. Session-scoped +
// route-checked storage lets the vote in one run suppress the restatement in the
// next while never crossing conversations. Single slot per session, TTL-bounded.
export const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

// Duplicate-send guard: models that re-narrate after each tool result
// (thinking-mode and small models especially) can call send twice with
// near-identical text in one run, double-posting the channel. Keyed per run
// (session fallback) and route-checked like the poll-vote echo above; TTL +
// bounded list so a long-lived gateway cannot accumulate state.
export const DUPLICATE_SEND_TTL_MS = 10 * 60 * 1000;
export const DUPLICATE_SEND_MAX_TRACKED_PER_RUN = 8;
// Both directions must be within 2x length so a short earlier send can never
// suppress a genuinely longer follow-up that merely quotes it.
export const DUPLICATE_SEND_MIN_LENGTH_RATIO = 0.5;
export const recentMessageToolSendsByRun = new Map<
  string,
  { sends: { route: string; normalized: string }[]; recordedAt: number }
>();

export function resolvePollVoteEchoRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return undefined;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId].filter((value): value is string =>
      Boolean(value),
    ),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core.
  // A route mismatch fails open; provider/account keys prevent cross-send suppression.
  const routeTarget = !target || currentTargets.has(target) ? "<current-source>" : target;
  return `${channel}\0${normalizeAccountId(params.accountId ?? "default")}\0${routeTarget}`;
}
