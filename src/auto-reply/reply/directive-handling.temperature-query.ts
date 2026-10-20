// Bare /temperature status query extracted from the directive handler.
import type { SessionEntry } from "../../config/sessions.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { formatTemperatureDirectiveReply } from "./directive-handling.temperature.js";

/**
 * Bare `/temperature` with no value is a query, not a mutation: answer with the
 * session's current value instead of falling through to the persistence path.
 */
export function resolveTemperatureQueryReply(
  directives: InlineDirectives,
  sessionEntry: SessionEntry,
): ReplyPayload | undefined {
  if (
    directives.hasTemperatureDirective &&
    directives.temperature === undefined &&
    !directives.clearTemperature
  ) {
    const sessionTemperature =
      typeof sessionEntry.temperature === "number" ? sessionEntry.temperature : undefined;
    return formatTemperatureDirectiveReply(directives, sessionTemperature);
  }
  return undefined;
}
