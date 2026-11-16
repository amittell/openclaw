/**
 * Turns a read chat history page into its response page: a worker-encoded page keeps its
 * serialized bytes (registering any precomputed deflate segment); any other page is prepared
 * and budgeted from its message objects.
 * Split out of ./chat-history-handler.ts to keep that module within the max-lines budget.
 */
import type { ChatHistoryPage } from "../../config/sessions/session-history-types.js";
import { prepareChatHistoryResponsePage } from "../chat-history-response-page.js";
import { SerializedJsonArray } from "../serialized-json.js";
import { registerDeflatedSegment } from "../server/ws-compression.js";

export function resolveChatHistoryResponsePage(
  historyPage: ChatHistoryPage,
  options: Parameters<typeof prepareChatHistoryResponsePage>[1],
) {
  if (historyPage.encodedResponse && historyPage.encodedMessagesDeflate) {
    registerDeflatedSegment(
      historyPage.encodedResponse.messages,
      historyPage.encodedMessagesDeflate,
    );
  }
  return historyPage.encodedResponse
    ? {
        ...historyPage.encodedResponse,
        messages: new SerializedJsonArray(historyPage.encodedResponse.messages),
        activity: historyPage.encodedResponse.activity
          ? new SerializedJsonArray(historyPage.encodedResponse.activity)
          : undefined,
      }
    : prepareChatHistoryResponsePage(historyPage, options);
}
