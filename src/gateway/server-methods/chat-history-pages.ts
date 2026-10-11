import os from "node:os";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { captureTranscriptRedactionSnapshot } from "../../agents/transcript-redact-text.js";
import { getCliSessionBinding } from "../../config/sessions/cli-session-binding.js";
import { readLegacyCompactionMetrics } from "../../config/sessions/legacy-compaction-history.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  projectForwardedMessages,
} from "../chat-display-projection.history.js";
import { resolveCurrentUserProfileDisplay } from "../current-user-profile-display.js";
import { createSessionHistorySubagentProjection } from "../session-history-subagent-projection.js";
import * as sessionTranscriptReaders from "../session-transcript-readers.js";
import { readChatHistoryPageKernel } from "./chat-history-page-kernel.js";

export { shouldReadAnchoredWindow } from "./chat-history-page-kernel.js";

export async function readChatHistoryPage(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
): Promise<ChatHistoryPage> {
  signal?.throwIfAborted();
  const binding = getCliSessionBinding(input.entry, "claude-cli");
  const params = binding?.sessionId
    ? {
        ...input,
        cliHistoryHomeDir: process.env.HOME || os.homedir(),
        cliHistoryRedaction: captureTranscriptRedactionSnapshot(),
      }
    : input;
  if (
    params.sessionId &&
    params.storePath &&
    (params.entry?.incognito || isIncognitoSessionKey(params.canonicalKey)) &&
    binding?.sessionId &&
    !params.ignoreCliSessionImports
  ) {
    const { readProcessHeldCliHistory } = await import("../cli-session-history.process-held.js");
    const page = await readProcessHeldCliHistory(params, signal);
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
  }
  if (
    !params.sessionId ||
    !params.storePath ||
    params.entry?.incognito ||
    isIncognitoSessionKey(params.canonicalKey)
  ) {
    const page = await readChatHistoryPageKernel(params, {
      readers: sessionTranscriptReaders,
      resolveCurrentUserProfileDisplay,
      resolveCronJobName: () => undefined,
    });
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
  }
  const { readSessionHistoryPageInWorker } =
    await import("../../config/sessions/session-history-worker-runtime.js");
  return readSessionHistoryPageInWorker(
    {
      kind: "rpc",
      params: {
        ...params,
        compactionMetrics: readLegacyCompactionMetrics(params.entry),
        sessionId: params.sessionId,
        storePath: params.storePath,
      },
    },
    signal,
  );
}

/**
 * Reads one page of the span a compaction summary shadowed; undefined when the id is not a
 * compaction in this session. Always local: the span reader is host-side, not one of the
 * worker's admitted readers, so this never takes readChatHistoryPage's worker path. It
 * never reaches the CLI-import readers either, so an import binding cannot answer a span
 * request with the live tail.
 */
export async function readChatHistoryCompactionSpanPage(
  params: ChatHistoryPageParams & { compactionId: string },
  signal?: AbortSignal,
): Promise<ChatHistoryPage | undefined> {
  signal?.throwIfAborted();
  if (!params.sessionId || !params.storePath) {
    const page = await readChatHistoryPageKernel(params, {
      readers: sessionTranscriptReaders,
      resolveCurrentUserProfileDisplay,
      resolveCronJobName: () => undefined,
    });
    return { ...page, messages: await refreshForwardedLabels(page.messages) };
  }
  const subagentCoordination =
    !params.entry?.incognito && !isIncognitoSessionKey(params.canonicalKey)
      ? createSessionHistorySubagentProjection({
          agentId: params.sessionAgentId,
          sessionId: params.sessionId,
          sessionKey: params.canonicalKey,
          storePath: params.storePath,
          sessionEntry: params.entry,
        })
      : undefined;
  let found = false;
  const page = await readChatHistoryPageKernel(params, {
    readers: { ...sessionTranscriptReaders, subagentCoordination },
    resolveCurrentUserProfileDisplay,
    resolveCronJobName: () => undefined,
    readCompactionShadowPage: async (readScope, opts) => {
      const span = await sessionTranscriptReaders.readSessionMessagesShadowedByCompactionAsync(
        readScope,
        opts,
      );
      found = span !== undefined;
      return span;
    },
  });
  subagentCoordination?.assertCurrent?.();
  signal?.throwIfAborted();
  return found ? { ...page, messages: await refreshForwardedLabels(page.messages) } : undefined;
}

async function refreshForwardedLabels(messages: unknown[]): Promise<unknown[]> {
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(messages);
  return projectForwardedMessages(
    messages.filter(
      (message): message is Record<string, unknown> => asOptionalRecord(message) !== undefined,
    ),
    resolveCronJobName,
  );
}
