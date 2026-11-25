import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { Admission, ScopedWriteRevision } from "./sqlite-database-admission-record.js";

// Retained bytes and retired keys per write-scope map; the admission record owns the policy.
export const scopeRetention = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteDatabaseWriteScopeRetention"),
  () => new WeakMap<Map<string, ScopedWriteRevision>, { bytes: number; retired: Set<string> }>(),
);
// Account for UTF-16 keys plus the UUID, shared cell, and map/snapshot entries.
export const writeScopeBytes = (key: string) => key.length * 2 + 256;

// Bucket snapshots bound copy-on-write work without retaining a history of revisions.
const EMPTY_WRITE_SCOPE_BUCKETS = Array.from(
  { length: 128 },
  () => new Map<string, ScopedWriteRevision>(),
);
export type WriteScopeBuckets = typeof EMPTY_WRITE_SCOPE_BUCKETS;

export function snapshotWriteScopes(
  current: Admission["writeScopes"],
  previous: WriteScopeBuckets = EMPTY_WRITE_SCOPE_BUCKETS,
  keys?: readonly string[],
): WriteScopeBuckets {
  let buckets = previous;
  const retention = scopeRetention.get(current);
  const visit = (value: ScopedWriteRevision | undefined, key: string) => {
    let hash = 0;
    for (let index = 0; index < key.length; index++) {
      hash = (hash * 31 + key.charCodeAt(index)) | 0;
    }
    const index = hash & (EMPTY_WRITE_SCOPE_BUCKETS.length - 1);
    const retired = !value || Atomics.load(value.state, 1) !== 0;
    if (retired) {
      if (current.delete(key) && retention) {
        retention.bytes -= writeScopeBytes(key);
      }
    }
    if (retired ? !previous[index]!.has(key) : previous[index]!.get(key) === value) {
      return;
    }
    if (buckets === previous) {
      buckets = previous.slice();
    }
    if (buckets[index] === previous[index]) {
      buckets[index] = new Map(previous[index]);
    }
    if (retired) {
      buckets[index]!.delete(key);
    } else {
      buckets[index]!.set(key, value!);
    }
  };
  if (keys) {
    for (const key of keys) {
      visit(current.get(key), key);
    }
  } else {
    current.forEach(visit);
  }
  for (const key of retention?.retired ?? []) {
    visit(current.get(key), key);
  }
  retention?.retired.clear();
  return buckets;
}
