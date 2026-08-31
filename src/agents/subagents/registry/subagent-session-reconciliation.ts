/**
 * Subagent session-store reconciliation.
 *
 * Infers child completion from persisted session entries when registry updates arrive late.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionStorePathCore,
  type SessionEntry,
} from "../../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
} from "../../../config/sessions/session-accessor.js";
import { normalizeStoreSessionKey } from "../../../config/sessions/store-entry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentRunOutcome } from "../announce/subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export type SubagentSessionStoreCache = Map<string, Record<string, SessionEntry>>;
export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

/** Completion inferred from the child session store. */
export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

function finiteTimestamp(value: number | undefined): number | undefined {
  return asFiniteNumber(value);
}

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return finiteTimestamp(sessionEntry?.endedAt) ?? finiteTimestamp(sessionEntry?.updatedAt);
}

function isFreshForRun(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): boolean {
  if (notBeforeMs === undefined) {
    return true;
  }
  const terminalAt = terminalSessionTimestamp(sessionEntry);
  return terminalAt !== undefined && terminalAt >= notBeforeMs;
}

function freshSessionStartedAt(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): number | undefined {
  const startedAt = finiteTimestamp(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

/** Load a child session entry using the agent-specific session store path. */
export function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  let store = params.storeCache?.get(storePath);
  if (!store) {
    store = Object.fromEntries(
      listSessionEntriesReadOnly({ storePath, clone: false }).map(({ sessionKey, entry }) => [
        sessionKey,
        entry,
      ]),
    );
    params.storeCache?.set(storePath, store);
  }
  return store[key] ?? store[normalizeStoreSessionKey(key)];
}

/** Resolve a child session entry without depending on the file-backed store shape. */
function loadSubagentSessionEntryForAccessor(params: {
  childSessionKey: string;
  cfg?: OpenClawConfig;
}): SessionEntry | undefined {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return loadSessionEntryReadOnly({
    storePath,
    sessionKey: key,
    clone: false,
  });
}

/** Resolves whether a registry row is orphaned from its child session entry. */
export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}): SubagentRunOrphanReason | null {
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  try {
    const sessionEntry = loadSubagentSessionEntryForAccessor({
      childSessionKey,
      cfg: params.cfg,
    });
    if (!sessionEntry) {
      return "missing-session-entry";
    }
    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }
    if (
      params.includeStaleUnended === true &&
      sessionEntry.abortedLastRun !== true &&
      isStaleUnendedSubagentRun(params.entry, params.now)
    ) {
      return "stale-unended-run";
    }
    return null;
  } catch {
    // Best-effort guard: avoid false orphan pruning on transient read/config failures.
    return null;
  }
}

/** Convert persisted session status into a subagent completion outcome. */
export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  const startedAt = freshSessionStartedAt(sessionEntry, opts?.notBeforeMs);
  const endedAt =
    finiteTimestamp(sessionEntry?.endedAt) ??
    finiteTimestamp(sessionEntry?.updatedAt) ??
    fallbackEndedAt;

  if (status === "done") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "timeout") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "timeout" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  if (status === "failed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "session completed before registry settled" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
    };
  }
  if (status === "killed") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "error", error: "subagent run terminated" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
    };
  }
  if (status !== "running" && typeof sessionEntry?.endedAt === "number") {
    if (!isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
      return null;
    }
    return {
      startedAt,
      endedAt,
      outcome: { status: "ok" },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
    };
  }
  return null;
}

/** Tool-call block types that indicate the assistant turn is still in progress. */
const TOOL_CALL_BLOCK_TYPES = new Set([
  "tool_use",
  "toolCall",
  "toolUse",
  "functionCall",
  "function_call",
]);

/** Maximum bytes to read from the tail of a transcript file. */
const TRANSCRIPT_TAIL_BYTES = 32 * 1024;

/** Read the tail of a file (up to `maxBytes`) as lines; empty on any I/O error. */
function readTranscriptTailLines(filePath: string, maxBytes: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const fileSize = fd >= 0 ? fstatSync(fd).size : 0;
    if (fileSize === 0) {
      return [];
    }
    const readSize = Math.min(maxBytes, fileSize);
    const offset = fileSize - readSize;
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, offset);
    const lines = buf.toString("utf-8").split("\n").filter(Boolean);
    // A partial tail starts mid-line; drop the truncated first line.
    if (offset > 0 && lines.length > 0) {
      lines.shift();
    }
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Resolve a transcript-based completion for a child session whose persisted
 * entry has no status yet. Scans the JSONL tail for the latest assistant
 * message; a completed reply (no pending tool calls, not after a newer
 * user/system turn) means the run finished before the registry settled.
 */
function resolveTranscriptCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  try {
    const sessionEntry = loadSubagentSessionEntry({
      childSessionKey: params.childSessionKey,
      storeCache: params.storeCache,
      cfg: params.cfg,
    });
    const sessionId =
      typeof sessionEntry?.sessionId === "string" ? sessionEntry.sessionId.trim() : "";
    if (!sessionId) {
      return null;
    }
    const cfg = params.cfg ?? getRuntimeConfig();
    const agentId = resolveAgentIdFromSessionKey(params.childSessionKey.trim());
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const transcriptPath = resolveSessionFilePathCore(
      sessionId,
      sessionEntry,
      resolveSessionFilePathOptions({ agentId, storePath }),
    );
    // SQLite-backed transcripts carry no JSONL tail to scan; fall back to the
    // persisted-session-entry completion path only.
    if (transcriptPath.startsWith("sqlite:") || !existsSync(transcriptPath)) {
      return null;
    }
    const lines = readTranscriptTailLines(transcriptPath, TRANSCRIPT_TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line) {
        continue;
      }
      try {
        // Transcript records are untrusted JSON; every field is compared against a
        // literal or guarded below, never dereferenced blindly.
        // SAFETY: only `message` is read, and it is re-narrowed on the next statement.
        const parsed = JSON.parse(line) as { message?: unknown };
        // SAFETY: every field is optional `unknown`, so no property access can throw.
        const message = (parsed.message ?? parsed) as {
          role?: unknown;
          content?: unknown;
          stopReason?: unknown;
          stop_reason?: unknown;
        };
        if (message.role === "assistant" && message.content != null) {
          const stopReason = message.stopReason ?? message.stop_reason;
          if (stopReason === "error" || stopReason === "aborted") {
            return null;
          }
          const blocks = Array.isArray(message.content) ? message.content : [message.content];
          const hasPendingTool = blocks.some(
            (block: unknown) =>
              typeof block === "object" &&
              block !== null &&
              // Guarded as a non-null object on the two lines above; the `type`
              // lookup feeds a Set membership test, so a non-string simply misses.
              // SAFETY: narrowed to a non-null object immediately above.
              TOOL_CALL_BLOCK_TYPES.has((block as Record<string, unknown>).type as string), // SAFETY: Set lookup tolerates a non-string.
          );
          if (hasPendingTool) {
            return null;
          }
          return {
            endedAt: params.fallbackEndedAt,
            outcome: { status: "ok" },
            reason: SUBAGENT_ENDED_REASON_COMPLETE,
          };
        }
        if (message.role === "user" || message.role === "system") {
          // A turn started after the last assistant reply; the reply above it
          // is stale evidence, not this run's completion.
          return null;
        }
      } catch {
        // skip malformed lines
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve recovered child completion for a stale unended registry row: the
 * persisted session entry first, then the transcript tail (a gateway restart
 * mid-flush can leave the entry unended while the run actually finished).
 */
export function resolveSubagentRecoveryCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    storeCache: params.storeCache,
    cfg: params.cfg,
  });
  const entryCompletion = resolveCompletionFromSessionEntry(sessionEntry, params.fallbackEndedAt, {
    notBeforeMs: params.notBeforeMs,
  });
  if (entryCompletion) {
    return entryCompletion;
  }
  return resolveTranscriptCompletion({
    childSessionKey: params.childSessionKey,
    fallbackEndedAt: params.fallbackEndedAt,
    storeCache: params.storeCache,
    cfg: params.cfg,
  });
}

/** Resolve child completion by reading its persisted session entry. */
export function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  return resolveCompletionFromSessionEntry(
    loadSubagentSessionEntry({
      childSessionKey: params.childSessionKey,
      storeCache: params.storeCache,
      cfg: params.cfg,
    }),
    params.fallbackEndedAt,
    { notBeforeMs: params.notBeforeMs },
  );
}

/** Resolve a fresh child session start time for lifecycle reconciliation. */
export function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  notBeforeMs?: number;
  storeCache?: SubagentSessionStoreCache;
  cfg?: OpenClawConfig;
}): number | undefined {
  const sessionEntry = loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    storeCache: params.storeCache,
    cfg: params.cfg,
  });
  return isFreshForRun(sessionEntry, params.notBeforeMs)
    ? freshSessionStartedAt(sessionEntry, params.notBeforeMs)
    : undefined;
}
