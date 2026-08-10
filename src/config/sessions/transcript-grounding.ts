// Grounding pass for replayed assistant transcript text.
//
// A model can fabricate a media reference: it invents an absolute path under
// the managed media dir and then "describes" the attachment as if it were
// real. Replaying that text into later prompts makes the fabrication
// self-reinforcing. Legitimate inbound media never reaches prompts as a raw
// absolute path (media-note.ts normalizes managed refs to media://inbound/...),
// so an absolute managed-media path inside assistant text that does not exist
// on disk is fabricated -- or expired, which is equally unusable. Redact only
// the path token and keep the surrounding prose; paths outside the managed
// media dir (code paths, host paths) are out of scope so ordinary technical
// conversation is never touched.
import { existsSync } from "node:fs";
import path from "node:path";
import { getMediaDir } from "../../media/store.js";

const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

// Characters that end a path token inside prose. Mirrors how paths are
// commonly delimited in model output: whitespace, quotes, brackets, and the
// backtick of inline code spans.
const PATH_TOKEN_END = /[\s"'`<>)\]}]/;

type GroundingOptions = {
  /** Managed media root; defaults to the configured media store dir. */
  mediaDir?: string;
  /** Existence probe, injectable for tests. */
  exists?: (candidate: string) => boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// macOS mounts /var as a symlink to /private/var, so managed media paths can
// legitimately appear with either spelling. Match both, verify either.
function managedMediaRoots(mediaDir: string): string[] {
  const resolved = path.resolve(mediaDir);
  const roots = new Set<string>([resolved]);
  if (resolved.startsWith("/private/var/")) {
    roots.add(resolved.slice("/private".length));
  } else if (resolved.startsWith("/var/")) {
    roots.add(`/private${resolved}`);
  }
  // Longest first so /private/var/... is consumed by its own root before the
  // bare /var/... twin can substring-match inside it.
  return [...roots].toSorted((a, b) => b.length - a.length);
}

// A root match must start a path token: the preceding character (if any) must
// not itself be part of a longer path or word, or /var/... would match inside
// /private/var/... and prose like "supervar/state" would false-positive.
function isPathTokenStart(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return !/[\w./-]/.test(text[index - 1] ?? "");
}

function findPathTokenEnd(text: string, start: number): number {
  for (let i = start; i < text.length; i += 1) {
    if (PATH_TOKEN_END.test(text[i] ?? "")) {
      return i;
    }
  }
  return text.length;
}

// Trailing sentence punctuation belongs to the prose, not the path.
function trimTrailingPunctuation(token: string): string {
  return token.replace(/[.,;:!?]+$/, "");
}

/**
 * Redacts absolute managed-media paths in assistant-authored text that do not
 * resolve to a real file. Returns the input unchanged (same reference) when
 * nothing needs redacting so callers can cheaply detect no-ops.
 */
export function redactUngroundedMediaRefs(text: string, options: GroundingOptions = {}): string {
  if (!text.includes("/")) {
    return text;
  }
  const mediaDir = options.mediaDir ?? getMediaDir();
  if (!mediaDir || !path.isAbsolute(mediaDir)) {
    return text;
  }
  const exists = options.exists ?? existsSync;
  let result = text;
  for (const root of managedMediaRoots(mediaDir)) {
    const rootPattern = new RegExp(`${escapeRegExp(root)}/`, "g");
    let match: RegExpExecArray | null;
    let rebuilt = "";
    let cursor = 0;
    let changed = false;
    while ((match = rootPattern.exec(result)) !== null) {
      const tokenStart = match.index;
      if (tokenStart < cursor || !isPathTokenStart(result, tokenStart)) {
        continue;
      }
      const tokenEnd = findPathTokenEnd(result, tokenStart);
      const token = trimTrailingPunctuation(result.slice(tokenStart, tokenEnd));
      if (token === `${root}/` || exists(token)) {
        continue;
      }
      rebuilt += result.slice(cursor, tokenStart) + UNGROUNDED_MEDIA_PLACEHOLDER;
      cursor = tokenStart + token.length;
      changed = true;
    }
    if (changed) {
      result = rebuilt + result.slice(cursor);
    }
  }
  return result;
}
