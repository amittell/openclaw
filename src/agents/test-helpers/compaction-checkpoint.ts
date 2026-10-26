import { formatCompactionCheckpointHandle } from "../../../packages/agent-core/src/index.js";

/**
 * Model-visible summary for a compaction boundary: the persisted summary bytes plus the checkpoint
 * line `buildSessionContext` appends at read time (`de6484af41b`). Persisted transcript bytes are
 * unchanged, so only context reads see this.
 *
 * Built from the real formatter on purpose. A hand-written copy of the line would keep passing
 * after production changed its wording, which is the failure this helper exists to prevent.
 */
export function expectedCompactionSummary(
  summary: string,
  handle: { entryId: string; shadowedEntryCount: number },
  readHint?: string,
): string {
  return `${summary}\n${formatCompactionCheckpointHandle(handle, readHint)}`;
}
