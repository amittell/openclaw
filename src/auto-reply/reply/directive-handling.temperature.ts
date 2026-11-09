// Temperature directive status/ack handling extracted from the directive handler.
import { TEMPERATURE_MAX, TEMPERATURE_MIN } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { withOptions } from "./directive-handling.shared.js";

const TEMPERATURE_RANGE = `${TEMPERATURE_MIN}–${TEMPERATURE_MAX}`;

/** Builds the temperature status/acknowledgement reply for a /temperature turn. */
export function formatTemperatureDirectiveReply(
  directives: InlineDirectives,
  sessionTemperature: number | undefined,
): ReplyPayload {
  const text = directives.rawTemperature
    ? `Unrecognized temperature "${directives.rawTemperature}". Valid range: ${TEMPERATURE_RANGE}.`
    : withOptions(
        `Current temperature: ${sessionTemperature ?? "default"}.`,
        `${TEMPERATURE_RANGE}, default`,
      );
  return { text };
}

/** Appends the temperature acknowledgement to the directive reply parts. */
export function appendTemperatureAck(directives: InlineDirectives, parts: string[]): void {
  if (directives.clearTemperature) {
    parts.push("Temperature reset to default.");
    return;
  }
  if (directives.hasTemperatureDirective && directives.temperature !== undefined) {
    parts.push(`Temperature set to ${directives.temperature}.`);
  }
}
