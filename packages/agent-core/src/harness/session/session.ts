import { stripCompactionReplayCheckpoint } from "@openclaw/ai/transports";
import type { AgentMessage } from "../../types.js";
import {
  asAgentMessage,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type {
  CompactionEntry,
  ResetEntry,
  SessionContext,
  SessionTreeEntry,
} from "../types.js";
import { selectResetKeptEntries } from "./tool-result-pairing.js";

type ContextBoundary = CompactionEntry | ResetEntry;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

/** The same semantic cut is used before payload acquisition and when building messages. */
function resolveSessionContextWindow(
  entries: readonly { id: string; type: string; firstKeptEntryId?: string }[],
): { boundaryIndex: number; firstKeptIndex: number } {
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.type === "reset" || entry.type === "compaction",
  );
  const firstKeptIndex = entries.findIndex(
    (entry) => entry.id === entries[boundaryIndex]?.firstKeptEntryId,
  );
  return {
    boundaryIndex,
    firstKeptIndex:
      firstKeptIndex >= 0 && firstKeptIndex < boundaryIndex ? firstKeptIndex : boundaryIndex,
  };
}

/** Project persisted session entries into the message shared by replay and summarization. */
export function projectSessionEntryMessage(entry: SessionTreeEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "message":
      // Display-only history stays persisted but never enters replay or summarization.
      return "excludeFromContext" in entry.message && entry.message.excludeFromContext === true
        ? undefined
        : entry.message;
    case "custom_message":
      return asAgentMessage(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );
    case "branch_summary":
      return asAgentMessage(
        createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
      );
    case "compaction":
      return asAgentMessage(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      );
    default:
      return undefined;
  }
}

/** Select the canonical window using only navigation and tool-pairing facts. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
): Generator<{ entry: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  const boundary = pathEntries[boundaryIndex];
  const resetKept =
    boundary?.type === "reset"
      ? new Set(selectResetKeptEntries(pathEntries.slice(firstKeptIndex, boundaryIndex)))
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  for (const [index, entry] of pathEntries.entries()) {
    const retained = index < boundaryIndex;
    if (
      index === boundaryIndex ||
      (retained && (index < firstKeptIndex || (resetKept && !resetKept.has(entry))))
    ) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (!resetKept?.has(entry) &&
        entry.type === "message" &&
        "excludeFromContext" in entry.message &&
        entry.message.excludeFromContext === true)
    ) {
      continue;
    }
    const context = retained ? (resetKept ? "reset-retained" : "retained") : "current";
    yield { entry, context };
  }
}

// Hard cap for the one model-visible line appended to a compaction summary.
const CHECKPOINT_HANDLE_MAX_CHARS = 160;

export type CompactionCheckpointHandle = { entryId: string; shadowedEntryCount: number };

export type BuildSessionContextOptions = {
  /** Hosts inject read-tool wording here; the default names no tool. */
  formatCheckpointHandle?: (handle: CompactionCheckpointHandle) => string;
};

/** Render the checkpoint line the model sees after a compaction summary. */
export function formatCompactionCheckpointHandle(
  handle: CompactionCheckpointHandle,
  readHint?: string,
): string {
  const shadows = `shadows ${handle.shadowedEntryCount} earlier entries`;
  return `[compaction checkpoint ${handle.entryId}: ${shadows}${readHint ? `; ${readHint}` : ""}]`;
}

function isBoundaryEntry(entry: SessionTreeEntry): entry is ContextBoundary {
  return entry.type === "compaction" || entry.type === "reset";
}

/** Index where a boundary's kept prefix starts; the boundary itself when it kept nothing. */
function resolveKeptPrefixIndex(
  pathEntries: readonly SessionTreeEntry[],
  boundary: ContextBoundary,
  boundaryIdx: number,
): number {
  const firstKeptIdx = pathEntries.findIndex((entry) => entry.id === boundary.firstKeptEntryId);
  return firstKeptIdx >= 0 && firstKeptIdx < boundaryIdx ? firstKeptIdx : boundaryIdx;
}

/**
 * Rows this summary replaced: the previous boundary's kept prefix (or the path start) up to this
 * one's. The kept prefix is excluded because it still replays verbatim, and only transcript-visible
 * rows count so the figure matches what a history reader can page through.
 */
function resolveShadowedEntryCount(
  pathEntries: readonly SessionTreeEntry[],
  boundary: ContextBoundary,
  boundaryIdx: number,
): number {
  const previousIdx = pathEntries.slice(0, boundaryIdx).findLastIndex(isBoundaryEntry);
  const previous = pathEntries[previousIdx];
  const spanStart =
    previous && isBoundaryEntry(previous)
      ? resolveKeptPrefixIndex(pathEntries, previous, previousIdx)
      : 0;
  return pathEntries
    .slice(spanStart, resolveKeptPrefixIndex(pathEntries, boundary, boundaryIdx))
    .filter((entry) => entry.type === "message" || isBoundaryEntry(entry)).length;
}

/** Hydrate selected messages lazily so bounded consumers can stop before later payloads. */
export function* iterateSessionContextMessages<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Generator<AgentMessage> {
  for (const { entry, context } of iterateSessionContextEntries(pathEntries)) {
    if (entry.type === "reset") {
      continue;
    }
    const hydrated = readEntry(entry);
    if (hydrated.type === "branch_summary" && !hydrated.summary) {
      continue;
    }
    // Explicit reset retention can include otherwise excluded user/assistant messages.
    let message =
      context === "reset-retained" && hydrated.type === "message"
        ? hydrated.message
        : projectSessionEntryMessage(hydrated);
    if (!message) {
      continue;
    }
    if (context !== "current" && message.role === "assistant") {
      message = stripCompactionReplayCheckpoint(message);
    }
    if (context === "reset-retained" && (message.role === "user" || message.role === "assistant")) {
      message = { ...message };
      Object.defineProperty(message, SESSION_HISTORY_PRELUDE, {
        configurable: true,
        enumerable: false,
        value: true,
      });
    }
    yield message;
  }
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(
  pathEntries: SessionTreeEntry[],
  options?: BuildSessionContextOptions,
): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let boundary: ContextBoundary | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    } else if (isBoundaryEntry(entry)) {
      boundary = entry;
    }
  }
  // Derived at read time so persisted summary bytes stay untouched and the handle
  // follows the boundary entry even after transcript rewrites. Injected through the
  // iterator's own readEntry seam so all of its replay semantics still apply.
  const activeBoundary = boundary;
  const readEntry =
    activeBoundary?.type === "compaction"
      ? (entry: SessionTreeEntry): SessionTreeEntry => {
          if (entry.id !== activeBoundary.id || entry.type !== "compaction") {
            return entry;
          }
          const boundaryIdx = pathEntries.findIndex((item) => item.id === activeBoundary.id);
          const format = options?.formatCheckpointHandle ?? formatCompactionCheckpointHandle;
          const handleLine = format({
            entryId: activeBoundary.id,
            shadowedEntryCount: resolveShadowedEntryCount(pathEntries, activeBoundary, boundaryIdx),
          }).slice(0, CHECKPOINT_HANDLE_MAX_CHARS);
          return { ...entry, summary: `${entry.summary}\n${handleLine}` };
        }
      : undefined;
  return {
    messages: Array.from(iterateSessionContextMessages(pathEntries, readEntry)),
    thinkingLevel,
    model,
  };
}
