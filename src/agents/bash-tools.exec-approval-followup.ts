import {
  resolveExternalBestEffortDeliveryTarget,
  type ExternalBestEffortDeliveryTarget,
} from "../infra/outbound/best-effort-delivery.js";
import { sendMessage } from "../infra/outbound/message.js";
import { isCronSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isGatewayMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  formatExecDeniedUserMessage,
  isExecDeniedResultText,
  parseExecApprovalResultText,
} from "./exec-approval-result.js";
import { detectExecRewriteRequired } from "./exec-rewrite-required.js";
import { sanitizeUserFacingText } from "./pi-embedded-helpers/errors.js";
import { callGatewayTool } from "./tools/gateway.js";

type ExecApprovalFollowupParams = {
  approvalId: string;
  sessionKey?: string;
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
  resultText: string;
};

function isRewriteRequiredDeniedResultText(resultText: string): boolean {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind !== "denied") {
    return false;
  }
  const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
  return metadata.includes("rewrite-required") || detectExecRewriteRequired(parsed.body) !== null;
}

function buildExecDeniedFollowupPrompt(resultText: string): string {
  const rewriteRequired = isRewriteRequiredDeniedResultText(resultText);
  return [
    "An async command did not run.",
    "Do not run the command again.",
    "There is no new command output.",
    "Do not mention, summarize, or reuse output from any earlier run in this session.",
    rewriteRequired
      ? "This denial is rewrite-required, not an approval wait. Rewrite the blocked step before continuing."
      : undefined,
    rewriteRequired
      ? "Use `apply_patch`, `edit`, or `write` for source edits, or replace the wrapper with one direct build/test/git/script command."
      : undefined,
    rewriteRequired
      ? "Do not wait for approval and do not rerun the same heredoc/temp-patch/stdin-fed interpreter command."
      : undefined,
    "",
    "Exact completion details:",
    resultText.trim(),
    "",
    rewriteRequired
      ? "Continue the task by rewriting the blocked step, then reply to the user in a helpful way."
      : "Reply to the user in a helpful way.",
    rewriteRequired
      ? "Explain that the command did not run because it must be rewritten using file tools or a direct command."
      : "Explain that the command did not run and why.",
    "Do not claim there is new command output.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

export function buildExecApprovalFollowupPrompt(resultText: string): string {
  const trimmed = resultText.trim();
  if (isExecDeniedResultText(trimmed)) {
    return buildExecDeniedFollowupPrompt(trimmed);
  }
  return [
    "An async command the user already approved has completed.",
    "Do not run the command again.",
    "If the task requires more steps, continue from this result before replying to the user.",
    "Only ask the user for help if you are actually blocked.",
    "",
    "Exact completion details:",
    trimmed,
    "",
    "Continue the task if needed, then reply to the user in a helpful way.",
    "If it succeeded, share the relevant output.",
    "If it failed, explain what went wrong.",
  ].join("\n");
}

function shouldSuppressExecDeniedFollowup(
  sessionKey: string | undefined,
  resultText: string,
): boolean {
  if (isCronSessionKey(sessionKey)) {
    return true;
  }
  if (!isSubagentSessionKey(sessionKey)) {
    return false;
  }
  return !isRewriteRequiredDeniedResultText(resultText);
}

function formatDirectExecApprovalFollowupText(
  resultText: string,
  opts: { allowDenied?: boolean } = {},
): string | null {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind === "other" && !parsed.raw) {
    return null;
  }
  if (parsed.kind === "denied") {
    return opts.allowDenied ? formatExecDeniedUserMessage(parsed.raw) : null;
  }

  if (parsed.kind === "finished") {
    const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
    const body = sanitizeUserFacingText(parsed.body, {
      errorContext: !metadata.includes("code 0"),
    }).trim();

    let prefix = "";
    if (!body) {
      prefix = metadata.includes("code 0")
        ? "Background command finished."
        : metadata.includes("signal")
          ? "Background command stopped unexpectedly."
          : "Background command finished with an error.";
    }

    return body ? `${prefix ? `${prefix}\n\n` : ""}${body}` : prefix || null;
  }

  if (parsed.kind === "completed") {
    const body = sanitizeUserFacingText(parsed.body, { errorContext: true }).trim();
    return body || "Background command finished.";
  }

  return sanitizeUserFacingText(parsed.raw, { errorContext: true }).trim() || null;
}

function buildSessionResumeFallbackPrefix(): string {
  return "Automatic session resume failed, so sending the status directly.\n\n";
}

function canDirectSendDeniedFollowup(sessionError: unknown): boolean {
  return sessionError !== null;
}

function buildAgentFollowupArgs(params: {
  approvalId: string;
  sessionKey: string;
  resultText: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  sessionOnlyOriginChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
}) {
  const { deliveryTarget, sessionOnlyOriginChannel } = params;
  const forceInternalOnly =
    isSubagentSessionKey(params.sessionKey) && isRewriteRequiredDeniedResultText(params.resultText);
  const shouldDeliverExternally = !forceInternalOnly && deliveryTarget.deliver;
  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    deliver: shouldDeliverExternally,
    ...(shouldDeliverExternally ? { bestEffortDeliver: true as const } : {}),
    channel: shouldDeliverExternally
      ? deliveryTarget.channel
      : sessionOnlyOriginChannel && !forceInternalOnly
        ? sessionOnlyOriginChannel
        : undefined,
    to: shouldDeliverExternally
      ? deliveryTarget.to
      : sessionOnlyOriginChannel && !forceInternalOnly
        ? params.turnSourceTo
        : undefined,
    accountId: shouldDeliverExternally
      ? deliveryTarget.accountId
      : sessionOnlyOriginChannel && !forceInternalOnly
        ? params.turnSourceAccountId
        : undefined,
    threadId: shouldDeliverExternally
      ? deliveryTarget.threadId
      : sessionOnlyOriginChannel && !forceInternalOnly
        ? params.turnSourceThreadId
        : undefined,
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  };
}

async function sendDirectFollowupFallback(params: {
  approvalId: string;
  deliveryTarget: ExternalBestEffortDeliveryTarget;
  resultText: string;
  sessionError: unknown;
}): Promise<boolean> {
  const directText = formatDirectExecApprovalFollowupText(params.resultText, {
    allowDenied: canDirectSendDeniedFollowup(params.sessionError),
  });
  if (!params.deliveryTarget.deliver || !directText) {
    return false;
  }

  const prefix = params.sessionError ? buildSessionResumeFallbackPrefix() : "";
  await sendMessage({
    channel: params.deliveryTarget.channel,
    to: params.deliveryTarget.to ?? "",
    accountId: params.deliveryTarget.accountId,
    threadId: params.deliveryTarget.threadId,
    content: `${prefix}${directText}`,
    agentId: undefined,
    idempotencyKey: `exec-approval-followup:${params.approvalId}`,
  });
  return true;
}

export async function sendExecApprovalFollowup(
  params: ExecApprovalFollowupParams,
): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const resultText = params.resultText.trim();
  if (!resultText) {
    return false;
  }
  const isDenied = isExecDeniedResultText(resultText);
  if (isDenied && shouldSuppressExecDeniedFollowup(sessionKey, resultText)) {
    return false;
  }

  const deliveryTarget = resolveExternalBestEffortDeliveryTarget({
    channel: params.turnSourceChannel,
    to: params.turnSourceTo,
    accountId: params.turnSourceAccountId,
    threadId: params.turnSourceThreadId,
  });
  const normalizedTurnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  const sessionOnlyOriginChannel =
    normalizedTurnSourceChannel && isGatewayMessageChannel(normalizedTurnSourceChannel)
      ? normalizedTurnSourceChannel
      : undefined;

  let sessionError: unknown = null;

  if (sessionKey) {
    try {
      await callGatewayTool(
        "agent",
        { timeoutMs: 60_000 },
        buildAgentFollowupArgs({
          approvalId: params.approvalId,
          sessionKey,
          resultText,
          deliveryTarget,
          sessionOnlyOriginChannel,
          turnSourceTo: params.turnSourceTo,
          turnSourceAccountId: params.turnSourceAccountId,
          turnSourceThreadId: params.turnSourceThreadId,
        }),
        { expectFinal: true },
      );
      return true;
    } catch (err) {
      sessionError = err;
    }
  }

  if (
    !isSubagentSessionKey(sessionKey) &&
    (await sendDirectFollowupFallback({
      approvalId: params.approvalId,
      deliveryTarget,
      resultText,
      sessionError,
    }))
  ) {
    return true;
  }

  if (sessionError) {
    throw new Error(`Session followup failed: ${formatUnknownError(sessionError)}`);
  }
  if (isDenied) {
    return false;
  }
  throw new Error("Session key or deliverable origin route is required");
}
