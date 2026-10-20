import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const mediaStoreLog = createSubsystemLogger("media/store");

/**
 * Validates and sanitizes a provenance scope stamp (a single path segment, e.g.
 * "tg--5240776892"). Returns the sanitized scope, or undefined when the value is
 * empty or unsafe (path separators, traversal, or an absolute path). Unsafe values
 * are dropped with a warning rather than throwing, so a bad stamp never blocks a save.
 *
 * Unlike the original-filename sanitizer, this preserves dashes (including runs) so a
 * negative chat id keeps its sign: "tg--5240776892" stays "tg--5240776892".
 */
export function sanitizeMediaScope(scope: string | undefined, caller: string): string | undefined {
  if (scope === undefined || scope === null || typeof scope !== "string") {
    return undefined;
  }
  const trimmed = scope.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed === "." ||
    trimmed === ".." ||
    path.isAbsolute(trimmed) ||
    path.posix.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed)
  ) {
    mediaStoreLog.warn(`${caller}: omitting unsafe media scope stamp: ${JSON.stringify(scope)}`);
    return undefined;
  }
  // Strip control characters and replace Windows-invalid characters so the stamp
  // is a safe single filename segment. Dashes are preserved (not collapsed) so a
  // negative chat id keeps its sign: "tg--5240776892" stays "tg--5240776892".
  const sanitized = trimmed
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    mediaStoreLog.warn(`${caller}: omitting empty media scope stamp: ${JSON.stringify(scope)}`);
    return undefined;
  }
  return sanitized;
}

/**
 * Emits the file-to-chat mapping that was missing from the gateway log. Only
 * inbound saves are logged; outbound and other subdirs stay quiet.
 */
export function logInboundMediaSaved(params: {
  id: string;
  scope?: string;
  size: number;
  subdir: string;
}): void {
  if (params.subdir !== "inbound") {
    return;
  }
  mediaStoreLog.info(
    `inbound media saved: id=${params.id} scope=${params.scope ?? "-"} size=${params.size} subdir=${params.subdir}`,
    { id: params.id, scope: params.scope ?? "-", size: params.size, subdir: params.subdir },
  );
}
