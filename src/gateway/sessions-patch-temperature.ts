// Session patch temperature validation extracted from the sessions patch applier.
import { normalizeTemperature, TEMPERATURE_MAX, TEMPERATURE_MIN } from "../auto-reply/thinking.js";

/**
 * Validates and applies a sessions.patch `temperature` field onto a next session
 * entry. `null` clears the override; a number in [0, 2] sets it; anything else
 * returns a user-facing error message. Returns null when no temperature error
 * occurred (including absent/undefined fields).
 */
export function applySessionPatchTemperature(
  next: { temperature?: number },
  patch: { temperature?: number | null },
): string | null {
  if (!("temperature" in patch) || patch.temperature === undefined) {
    return null;
  }
  const raw = patch.temperature;
  if (raw === null) {
    delete next.temperature;
    return null;
  }
  const normalized = normalizeTemperature(String(raw));
  if (normalized === undefined) {
    return `invalid temperature (use a number between ${TEMPERATURE_MIN} and ${TEMPERATURE_MAX})`;
  }
  next.temperature = normalized;
  return null;
}
