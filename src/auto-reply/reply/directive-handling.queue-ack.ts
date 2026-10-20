// Queue directive acknowledgements extracted from the directive handler.
import { prefixSystemMessage } from "../../infra/system-message.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/** Appends the applied /queue settings to the directive reply parts. */
export function appendQueueDirectiveAcks(directives: InlineDirectives, parts: string[]): void {
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(prefixSystemMessage(`Queue mode set to ${directives.queueMode}.`));
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(prefixSystemMessage("Queue mode reset to default."));
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    parts.push(prefixSystemMessage(`Queue debounce set to ${directives.debounceMs}ms.`));
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(prefixSystemMessage(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(prefixSystemMessage(`Queue drop set to ${directives.dropPolicy}.`));
  }
}
