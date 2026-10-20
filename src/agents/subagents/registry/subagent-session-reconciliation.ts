import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
} from "../../../config/sessions.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { hasRetainedRequiredCompletionDelivery } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
};

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return asFiniteNumber(sessionEntry?.endedAt) ?? asFiniteNumber(sessionEntry?.updatedAt);
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
  const startedAt = asFiniteNumber(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

/** Read the current child entry; session-key scope also selects incognito storage. */
export async function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  childAgentId?: string;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SessionEntry | undefined> {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(key, params.childAgentId);
  const cfg = params.cfg ?? getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return readSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: key, projection: "list" },
    params.assertCurrent,
  );
}

export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}):
  | SubagentRunOrphanReason
  | null
  | {
      read: (assertCurrent: () => void) => Promise<{
        orphanReason: SubagentRunOrphanReason | null;
        sessionEntry: SessionEntry | undefined;
      }>;
    } {
  const { entry } = params;
  // Execution, recovery, and completion obligations outlive individual turns.
  // Missing session metadata must not steal those owners or manufacture success.
  if (
    entry.execution.outcome ||
    entry.collectorCompletion ||
    entry.requesterSettleWake ||
    hasRetainedRequiredCompletionDelivery(entry) ||
    entry.pauseReason ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.restartRecovery ||
    entry.terminalOwner === "interrupted-recovery" ||
    entry.suppressAnnounceReason === "steer-restart" ||
    entry.execution.status === "queued" ||
    getAgentRunContext(entry.runId)
  ) {
    return null;
  }
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  return {
    async read(assertCurrent) {
      const sessionEntry = await loadSubagentSessionEntry({
        childSessionKey,
        childAgentId: entry.childAgentId,
        cfg: params.cfg,
        assertCurrent,
      });
      let orphanReason: SubagentRunOrphanReason | null = null;
      if (!sessionEntry) {
        orphanReason = "missing-session-entry";
      } else if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
        orphanReason = "missing-session-id";
      } else if (
        params.includeStaleUnended === true &&
        sessionEntry.abortedLastRun !== true &&
        entry.execution.status !== "interrupted" &&
        isStaleUnendedSubagentRun(entry, params.now)
      ) {
        orphanReason = "stale-unended-run";
      }
      return { orphanReason, sessionEntry };
    },
  };
}

export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  // Interruption leaves registry settlement with the recovery owner.
  if (status === "interrupted" || !isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
    return null;
  }
  let outcome: SubagentRunOutcome;
  let reason: SubagentLifecycleEndedReason = SUBAGENT_ENDED_REASON_COMPLETE;
  switch (status) {
    case "failed":
      outcome = {
        status: "error",
        error: sessionEntry?.lastRunError || "session completed before registry settled",
      };
      reason = SUBAGENT_ENDED_REASON_ERROR;
      break;
    case "killed":
      outcome = { status: "error", error: "subagent run terminated" };
      reason = SUBAGENT_ENDED_REASON_KILLED;
      break;
    case "timeout":
      outcome = { status: "timeout", error: sessionEntry?.lastRunError };
      break;
    default:
      if (status !== "done" && typeof sessionEntry?.endedAt !== "number") {
        return null;
      }
      outcome = { status: "ok" };
  }
  return {
    startedAt: freshSessionStartedAt(sessionEntry, opts?.notBeforeMs),
    endedAt: terminalSessionTimestamp(sessionEntry) ?? fallbackEndedAt,
    outcome,
    reason,
  };
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
  childAgentId?: string;
  sessionEntry: SessionEntry | undefined;
  fallbackEndedAt: number;
  cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null {
  try {
    const { sessionEntry } = params;
    const sessionId =
      typeof sessionEntry?.sessionId === "string" ? sessionEntry.sessionId.trim() : "";
    if (!sessionId) {
      return null;
    }
    const cfg = params.cfg ?? getRuntimeConfig();
    const agentId = resolveAgentIdFromSessionKey(
      params.childSessionKey.trim(),
      params.childAgentId,
    );
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
export async function resolveSubagentRecoveryCompletion(params: {
  childSessionKey: string;
  childAgentId?: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SubagentSessionCompletion | null> {
  // One worker read serves both paths; a retired read throws through to the caller.
  const sessionEntry = await loadSubagentSessionEntry({
    childSessionKey: params.childSessionKey,
    childAgentId: params.childAgentId,
    cfg: params.cfg,
    assertCurrent: params.assertCurrent,
  });
  const entryCompletion = resolveCompletionFromSessionEntry(sessionEntry, params.fallbackEndedAt, {
    notBeforeMs: params.notBeforeMs,
  });
  if (entryCompletion) {
    return entryCompletion;
  }
  return resolveTranscriptCompletion({
    childSessionKey: params.childSessionKey,
    childAgentId: params.childAgentId,
    sessionEntry,
    fallbackEndedAt: params.fallbackEndedAt,
    cfg: params.cfg,
  });
}

/** Resolve child completion by reading its persisted session entry. */
export async function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  childAgentId?: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SubagentSessionCompletion | null> {
  return withSubagentSessionEntry(params, (entry) =>
    resolveCompletionFromSessionEntry(entry, params.fallbackEndedAt, {
      notBeforeMs: params.notBeforeMs,
    }),
  );
}

async function withSubagentSessionEntry<T>(
  params: {
    childSessionKey: string;
    childAgentId?: string;
    cfg?: OpenClawConfig;
    assertCurrent?: () => void;
  },
  consume: (entry: SessionEntry | undefined) => T,
): Promise<T> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params, cfg);
  return withSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: params.childSessionKey, projection: "list" },
    () => params.assertCurrent?.(),
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return consume(read.value);
    },
  );
}

export async function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  childAgentId?: string;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<number | undefined> {
  return withSubagentSessionEntry(params, (entry) =>
    isFreshForRun(entry, params.notBeforeMs)
      ? freshSessionStartedAt(entry, params.notBeforeMs)
      : undefined,
  );
}
