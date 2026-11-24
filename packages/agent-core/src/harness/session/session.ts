import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stripCompactionReplayCheckpoint } from "../../../../ai/src/transports/provider-compaction-checkpoint.js";
import { getOpenClawSystemUpdateKind } from "../../operator-messages.js";
import type { AgentMessage } from "../../types.js";
import {
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import type { SessionContext, SessionTreeEntry } from "../types.js";
import { selectResetKeptMessageFacts, type ToolPairingMessageFact } from "./tool-pairing-facts.js";
import { collectToolPairingMessageFact, selectResetKeptEntries } from "./tool-result-pairing.js";
import { isTranscriptArtifactProvider } from "./transcript-model.js";

// Derived from the exported union so the boundary entry types stay internal to
// agent-core rather than being exported just for this file.
type ContextBoundary = Extract<SessionTreeEntry, { type: "compaction" | "reset" }>;
const SESSION_HISTORY_PRELUDE = Symbol.for("openclaw.sessionHistoryPrelude");

function isExcludedCustomMessage(entry: Extract<SessionTreeEntry, { type: "custom_message" }>) {
  // Existing failure receipts predate the generic context exclusion marker.
  return entry.excludeFromContext === true || entry.customType === "run-failed-before-reply";
}

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
      if (isExcludedCustomMessage(entry)) {
        return undefined;
      }
      return createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      );
    case "branch_summary":
      return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
    case "compaction":
      return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
    default:
      return undefined;
  }
}

export type SessionContextEntryFact = {
  id: string;
  type: SessionTreeEntry["type"];
  firstKeptEntryId?: string;
  role?: AgentMessage["role"];
  pairing?: ToolPairingMessageFact;
  excluded: boolean;
  promptBoundary: boolean;
  promptUpdate: boolean;
};

export function collectSessionContextEntryFact(entry: SessionTreeEntry): SessionContextEntryFact {
  const message = entry.type === "message" ? entry.message : undefined;
  return {
    id: entry.id,
    type: entry.type,
    firstKeptEntryId:
      entry.type === "compaction" || entry.type === "reset" ? entry.firstKeptEntryId : undefined,
    role: message?.role,
    pairing: message ? collectToolPairingMessageFact(message) : undefined,
    excluded:
      entry.type === "custom_message"
        ? isExcludedCustomMessage(entry)
        : Boolean(
            message && "excludeFromContext" in message && message.excludeFromContext === true,
          ),
    promptBoundary:
      entry.type === "custom" &&
      entry.customType === "openclaw.system-prompt" &&
      asOptionalRecord(entry.data)?.restart === true,
    promptUpdate: getOpenClawSystemUpdateKind(entry) === "prompt-update",
  };
}

export function selectResetKeptContextEntryFacts<T extends SessionContextEntryFact>(
  entries: readonly T[],
): T[] {
  return selectResetKeptMessageFacts(
    entries.flatMap((entry) =>
      entry.type === "message" && entry.role
        ? [{ entry, role: entry.role, pairing: entry.pairing, identity: entry }]
        : [],
    ),
  ).map(({ entry }) => entry);
}

/** The release array adapter and payload-free worker share exactly one window selector. */
export function* iterateSessionContextEntries<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
) {
  const entries = pathEntries.map((source) => ({
    ...collectSessionContextEntryFact(source),
    source,
  }));
  for (const selected of iterateContextFacts(entries, (selectedFacts) => {
    const selectedSources = new Set(
      selectResetKeptEntries(selectedFacts.map((fact) => fact.source)),
    );
    return selectedFacts.filter((fact) => selectedSources.has(fact.source));
  })) {
    yield { entry: selected.entry.source, context: selected.context };
  }
}

export function* iterateSessionContextEntryFacts<T extends SessionContextEntryFact>(
  pathEntries: readonly T[],
) {
  yield* iterateContextFacts(pathEntries, selectResetKeptContextEntryFacts);
}

function* iterateContextFacts<T extends SessionContextEntryFact>(
  pathEntries: readonly T[],
  selectReset: (entries: readonly T[]) => T[],
): Generator<{ entry: T; context: "current" | "retained" | "reset-retained" }> {
  const { boundaryIndex, firstKeptIndex } = resolveSessionContextWindow(pathEntries);
  // A rebuilt prefix retires prompt overrides; retained turns still own their runtime facts.
  const operatorBoundaryIndex = Math.max(
    boundaryIndex,
    pathEntries.findLastIndex((entry) => entry.promptBoundary),
  );
  const boundary = pathEntries[boundaryIndex];
  const resetKept =
    boundary?.type === "reset"
      ? new Set(selectReset(pathEntries.slice(firstKeptIndex, boundaryIndex)))
      : undefined;
  if (boundary) {
    yield { entry: boundary, context: "current" };
  }
  let index = -1;
  for (const entry of pathEntries) {
    index += 1;
    const retained = index < boundaryIndex;
    if (
      index === boundaryIndex ||
      (retained && (index < firstKeptIndex || (resetKept && !resetKept.has(entry))))
    ) {
      continue;
    }
    if (index < operatorBoundaryIndex && entry.promptUpdate) {
      continue;
    }
    const hasMessage =
      entry.type === "message" ||
      entry.type === "custom_message" ||
      entry.type === "branch_summary";
    if (
      !hasMessage ||
      (entry.type === "custom_message" && entry.excluded) ||
      (!resetKept?.has(entry) && entry.type === "message" && entry.excluded)
    ) {
      continue;
    }
    const context = retained ? (resetKept ? "reset-retained" : "retained") : "current";
    yield { entry, context };
  }
}

// Hard cap for the one model-visible line appended to a compaction summary.
const CHECKPOINT_HANDLE_MAX_CHARS = 160;

export type CompactionCheckpointHandle = {
  entryId: string;
  /** Absent for boundaries written before the count was persisted with them. */
  shadowedEntryCount?: number;
};

export type BuildSessionContextOptions = {
  /** Hosts inject read-tool wording here; the default names no tool. */
  formatCheckpointHandle?: (handle: CompactionCheckpointHandle) => string;
};

/** Render the checkpoint line the model sees after a compaction summary. */
export function formatCompactionCheckpointHandle(
  handle: CompactionCheckpointHandle,
  readHint?: string,
): string {
  const facts = [
    handle.shadowedEntryCount === undefined
      ? undefined
      : `shadows ${handle.shadowedEntryCount} earlier entries`,
    readHint,
  ].filter(Boolean);
  return `[compaction checkpoint ${handle.entryId}${facts.length ? `: ${facts.join("; ")}` : ""}]`;
}

function isBoundaryEntry(entry: SessionTreeEntry): entry is ContextBoundary {
  return entry.type === "compaction" || entry.type === "reset";
}

/** Index where a boundary's kept prefix starts; the boundary itself when it kept nothing. */
function resolveKeptPrefixIndex(
  pathEntries: readonly SessionTreeEntry[],
  firstKeptEntryId: string | undefined,
  boundaryIdx: number,
): number {
  const firstKeptIdx = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  return firstKeptIdx >= 0 && firstKeptIdx < boundaryIdx ? firstKeptIdx : boundaryIdx;
}

/**
 * Rows a compaction appended after `pathEntries` replaces: the previous boundary's kept prefix (or
 * the path start) up to `firstKeptEntryId`. The kept prefix is excluded because it still replays
 * verbatim, and only transcript-visible rows count so the figure matches what a history reader can
 * page through.
 *
 * Writers persist this with the boundary. A bounded read after the compaction no longer holds the
 * rows it shadows, so counting there reported 0 where a full read reported the real figure, and
 * the two readers rendered different context bytes. Rows a bounded load had already omitted when
 * the compaction was written are not counted; the summary did not cover them either.
 */
export function countCompactionShadowedEntries(
  pathEntries: readonly SessionTreeEntry[],
  firstKeptEntryId: string,
): number {
  const previousIdx = pathEntries.findLastIndex(isBoundaryEntry);
  const previous = pathEntries[previousIdx];
  const spanStart =
    previous && isBoundaryEntry(previous)
      ? resolveKeptPrefixIndex(pathEntries, previous.firstKeptEntryId, previousIdx)
      : 0;
  return pathEntries
    .slice(spanStart, resolveKeptPrefixIndex(pathEntries, firstKeptEntryId, pathEntries.length))
    .filter((entry) => entry.type === "message" || isBoundaryEntry(entry)).length;
}

/** Hydrate selected messages lazily so bounded consumers can stop before later payloads. */
export function* iterateSessionContextMessages<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
): Generator<AgentMessage> {
  for (const selected of iterateSessionContextEntries(pathEntries)) {
    const message = projectSessionContextMessage(selected, readEntry);
    if (message) {
      yield message;
    }
  }
}

/** Project one selected entry without changing its canonical position or retained context. */
export function projectSessionContextMessage<T extends SessionTreeEntry>(
  { entry, context }: { entry: T; context: "current" | "retained" | "reset-retained" },
  readEntry: (entry: T) => SessionTreeEntry = (selected) => selected,
): AgentMessage | undefined {
  if (entry.type === "reset") {
    return undefined;
  }
  const hydrated = readEntry(entry);
  if (hydrated.type === "branch_summary" && !hydrated.summary) {
    return undefined;
  }
  // Explicit reset retention can include otherwise excluded user/assistant messages.
  let message =
    context === "reset-retained" && hydrated.type === "message"
      ? hydrated.message
      : projectSessionEntryMessage(hydrated);
  if (!message) {
    return undefined;
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
  return message;
}

/**
 * Wraps a caller's `readEntry` so the active compaction boundary renders its read-time checkpoint
 * line. Persisted summary bytes stay untouched and the handle follows the boundary entry across
 * transcript rewrites.
 *
 * Exported because there are TWO context readers over the same iterator: `buildSessionContext`
 * here, and the SQLite detached reader behind `readSessionTranscriptContextMessages` (which feeds
 * `readCodexSessionContext`). Injecting the line in only one of them made the two disagree about
 * what the model sees after a compaction.
 */
export function withCompactionCheckpointHandle<T extends SessionTreeEntry>(
  pathEntries: readonly T[],
  readEntry: (entry: T) => SessionTreeEntry = (entry) => entry,
  options?: BuildSessionContextOptions,
): (entry: T) => SessionTreeEntry {
  let boundary: ContextBoundary | null = null;
  for (const entry of pathEntries) {
    if (isBoundaryEntry(entry)) {
      boundary = entry;
    }
  }
  if (boundary?.type !== "compaction") {
    return readEntry;
  }
  const activeBoundaryId = boundary.id;
  return (entry: T): SessionTreeEntry => {
    // Hydrate first: the SQLite reader's own readEntry is what materializes the summary text, and
    // its navigation rows carry only control fields, so the count is read from the hydrated row.
    const hydrated = readEntry(entry);
    if (entry.id !== activeBoundaryId || hydrated.type !== "compaction") {
      return hydrated;
    }
    const format = options?.formatCheckpointHandle ?? formatCompactionCheckpointHandle;
    const shadowedEntryCount = hydrated.shadowedEntryCount;
    const handleLine = format({
      entryId: activeBoundaryId,
      ...(typeof shadowedEntryCount === "number" ? { shadowedEntryCount } : {}),
    }).slice(0, CHECKPOINT_HANDLE_MAX_CHARS);
    return { ...hydrated, summary: `${hydrated.summary}\n${handleLine}` };
  };
}

/** Build model context from an ordered session branch and its latest state markers. */
export function buildSessionContext(
  pathEntries: readonly SessionTreeEntry[],
  options?: BuildSessionContextOptions,
): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.type === "model_change" && !isTranscriptArtifactProvider(entry.provider)) {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      !isTranscriptArtifactProvider(entry.message.provider)
    ) {
      model = { provider: entry.message.provider, modelId: entry.message.model };
    }
  }
  const readEntry = withCompactionCheckpointHandle(pathEntries, undefined, options);
  return {
    messages: Array.from(iterateSessionContextMessages(pathEntries, readEntry)),
    thinkingLevel,
    model,
  };
}
