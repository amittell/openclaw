/**
 * Applies a sessions.patch `toolOverrides` field onto the next session entry: `null` clears the
 * overlay, and a value replaces it with its normalized form (or clears it when nothing remains).
 * Split out of ./sessions-patch.ts to keep that module within the max-lines budget.
 */
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { normalizeSessionToolOverrides } from "../config/sessions/session-tool-overrides.js";

export function applySessionPatchToolOverrides(
  next: SessionEntry,
  patch: SessionsPatchParams,
): void {
  if ("toolOverrides" in patch) {
    const raw = patch.toolOverrides;
    if (raw === null) {
      delete next.toolOverrides;
    } else if (raw !== undefined) {
      // Session patches replace this sparse overlay atomically; they never deep-merge old policy.
      const normalized = normalizeSessionToolOverrides(raw);
      if (normalized) {
        next.toolOverrides = normalized;
      } else {
        delete next.toolOverrides;
      }
    }
  }
}
