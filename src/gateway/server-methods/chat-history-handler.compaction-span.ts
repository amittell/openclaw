/**
 * chat.history reads selected by `compactionId`: one page of the span a compaction summary
 * shadowed instead of the ordinary history page, and the request error for an id that is not
 * a compaction checkpoint in the session.
 * Split out of ./chat-history-handler.ts to keep that module within the max-lines budget.
 */
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type {
  ChatHistoryPage,
  ChatHistoryPageParams,
} from "../../config/sessions/session-history-types.js";
import {
  type ChatHistoryMessageProjector,
  readChatHistoryCompactionSpanPage,
  readChatHistoryPage,
} from "./chat-history-pages.js";

/**
 * Undefined only for a `compactionId` that names no compaction in this session. The display
 * projector (channel mentions) applies to the ordinary page only; span pages keep the kernel's
 * own display.
 */
export function readChatHistoryPageOrCompactionSpan(
  input: ChatHistoryPageParams,
  signal?: AbortSignal,
  displayProjector?: ChatHistoryMessageProjector,
): Promise<ChatHistoryPage | undefined> {
  const { compactionId, ...pageInput } = input;
  if (compactionId === undefined) {
    return readChatHistoryPage(pageInput, signal, displayProjector);
  }
  // The span read takes the shared page fields only: no response-encoding flags and
  // no page cursor.
  const {
    encodeResponse: _encodeResponse,
    deflateResponse: _deflateResponse,
    pageCursor: _pageCursor,
    ...spanInput
  } = pageInput;
  return readChatHistoryCompactionSpanPage({ ...spanInput, compactionId }, signal);
}

export function chatHistoryCompactionNotFoundError(compactionId: string | undefined): ErrorShape {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `compactionId "${compactionId}" is not a compaction checkpoint in this session; ` +
      'compaction rows in history carry __openclaw.kind "compaction" and the id in __openclaw.id',
  );
}
