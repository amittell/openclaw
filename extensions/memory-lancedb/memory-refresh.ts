import { appendFile, chmod, mkdir, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Type } from "typebox";
import type { OpenClawPluginApi } from "./api.js";
import { MEMORY_CATEGORIES } from "./config.js";
import type { Embeddings } from "./embeddings.js";
import type { MemoryDB, MemoryEntry } from "./lancedb-store.js";

// Keep conflict previews aligned with MemoryDB.search's default threshold.
const REFRESH_CONFLICT_MIN_SCORE = 0.5;

// Raw UUID keys are globally unique, so agent namespaces cannot collide.
const memoryLocks = new Map<string, Promise<void>>();

function finiteVectorFromArrayLike(value: ArrayLike<unknown>): number[] | null {
  const vector: number[] = [];
  for (const item of Array.from(value)) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      return null;
    }
    vector.push(item);
  }
  return vector;
}

function normalizeStoredMemoryVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    return finiteVectorFromArrayLike(value) ?? [];
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return finiteVectorFromArrayLike(value as unknown as ArrayLike<unknown>) ?? [];
  }
  if (typeof value === "string") {
    try {
      const parsedVector = normalizeStoredMemoryVector(JSON.parse(value) as unknown);
      if (parsedVector.length > 0) {
        return parsedVector;
      }
    } catch {}
    return [];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.toArray === "function") {
    try {
      const vector = normalizeStoredMemoryVector(record.toArray.call(value));
      if (vector.length > 0) {
        return vector;
      }
    } catch {}
  }
  for (const key of ["values", "data", "vector", "embedding"] as const) {
    if (key in record) {
      const vector = normalizeStoredMemoryVector(record[key]);
      if (vector.length > 0) {
        return vector;
      }
    }
  }
  if (typeof record.length === "number") {
    return finiteVectorFromArrayLike(record as unknown as ArrayLike<unknown>) ?? [];
  }
  return [];
}

function scoreStoredVectorSimilarity(existingVector: unknown, nextVector: number[]): number | null {
  const previousVector = normalizeStoredMemoryVector(existingVector);
  if (previousVector.length === 0 || previousVector.length !== nextVector.length) {
    return null;
  }
  let l2sq = 0;
  for (let index = 0; index < previousVector.length; index += 1) {
    const diff = (previousVector[index] ?? 0) - (nextVector[index] ?? 0);
    l2sq += diff * diff;
  }
  return 1 / (1 + Math.sqrt(l2sq));
}

export function withMemoryLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = memoryLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  memoryLocks.set(id, next);
  return previous.then(fn).finally(() => {
    release();
    if (memoryLocks.get(id) === next) {
      memoryLocks.delete(id);
    }
  });
}

export function registerMemoryRefreshTool(params: {
  api: OpenClawPluginApi;
  db: MemoryDB;
  embeddings: Embeddings;
  resolveEnabledAgentId: (
    rawAgentId: string | undefined,
    runtimeConfig?: OpenClawConfig,
  ) => string | undefined;
  resolveRuntimeConfig: () => OpenClawConfig;
}): void {
  const { api, db, embeddings, resolveEnabledAgentId, resolveRuntimeConfig } = params;
  api.registerTool(
    (ctx) => {
      const agentId = resolveEnabledAgentId(
        ctx.agentId,
        ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? resolveRuntimeConfig(),
      );
      if (!agentId) {
        return null;
      }
      return {
        name: "memory_refresh",
        label: "Memory Refresh",
        description:
          "Search for existing memories similar to new content, or replace a specific memory by ID. Use for updating facts: call without memoryId to preview similar memories, then call with memoryId to perform a best-effort replace with process-level serialization. The replace path is NOT a storage-level transaction (LanceDB does not expose multi-statement transactions through this code path); it is a process-mutex-serialized delete-then-insert with best-effort rollback on insert failure. The replaced entry keeps its original id so any cached references stay valid.",
        parameters: Type.Object({
          text: Type.String({ description: "New memory content (required in execute mode)" }),
          category: Type.Optional(Type.Enum(MEMORY_CATEGORIES, { type: "string" })),
          importance: Type.Optional(
            Type.Number({ description: "Importance 0.0-1.0 (default: inherited or 0.7)" }),
          ),
          memoryId: Type.Optional(
            Type.String({
              description:
                "If provided: best-effort replace of this memory (process-mutex serialized, not a storage-level transaction). If omitted: search-only mode.",
            }),
          ),
        }),
        async execute(_toolCallId, rawParams) {
          const { text, category, importance, memoryId } = rawParams as {
            text: string;
            category?: MemoryEntry["category"];
            importance?: number;
            memoryId?: string;
          };

          if (!memoryId) {
            const vector = await embeddings.embed(agentId, text);
            const results = await db.search(agentId, vector, 3, REFRESH_CONFLICT_MIN_SCORE);
            const matches = results.map((result) => ({
              id: result.entry.id,
              text: result.entry.text,
              category: result.entry.category,
              importance: result.entry.importance,
              similarity: result.score,
            }));
            const summaryText =
              matches.length === 0
                ? "No similar memories found."
                : `Found ${matches.length} similar memories:\n\n${matches
                    .map(
                      (match, index) =>
                        `${index + 1}. [${match.id.slice(0, 8)}] (${(match.similarity * 100).toFixed(0)}%) ${match.text}`,
                    )
                    .join("\n")}`;
            return {
              content: [{ type: "text", text: summaryText }],
              details: { operation: "search_only", matches },
            };
          }

          // Avoid a remote embedding call for a stale ID, then embed outside
          // the lock so another refresh for the same row is not blocked on I/O.
          const precheck = await db.getById(agentId, memoryId);
          if (!precheck) {
            return {
              content: [{ type: "text", text: `Memory ${memoryId} not found.` }],
              details: { operation: "error", error: "not_found", memoryId },
            };
          }
          const vector = await embeddings.embed(agentId, text);

          return withMemoryLock(memoryId, async () => {
            const existing = await db.getById(agentId, memoryId);
            if (!existing) {
              return {
                content: [{ type: "text", text: `Memory ${memoryId} not found.` }],
                details: { operation: "error", error: "not_found", memoryId },
              };
            }

            const resolvedCategory = category ?? existing.category;
            const resolvedImportance = importance ?? existing.importance;
            const oldTextPreview = existing.text.slice(0, 80);
            await db.delete(agentId, memoryId);

            let newEntry: MemoryEntry;
            let rollbackWarning: string | undefined;
            let rollbackSucceeded = false;
            try {
              newEntry = await db.store(
                agentId,
                { text, vector, importance: resolvedImportance, category: resolvedCategory },
                { id: memoryId },
              );
            } catch (insertError) {
              try {
                await db.storeRaw(agentId, existing);
                rollbackSucceeded = true;
                rollbackWarning = `Insert failed; original restored with original ID ${existing.id}. Insert error: ${String(insertError)}`;
              } catch (rollbackError) {
                rollbackWarning = `Insert failed AND rollback failed (DATA LOSS POSSIBLE). Insert: ${String(insertError)}. Rollback: ${String(rollbackError)}`;
              }
              return {
                content: [{ type: "text", text: `Replace failed: ${rollbackWarning}` }],
                details: {
                  operation: "error",
                  error: "insert_failed",
                  success: false,
                  rollbackWarning,
                  ...(rollbackSucceeded ? { restored_id: existing.id } : { restored_id: null }),
                },
              };
            }

            const similarity = scoreStoredVectorSimilarity(existing.vector, vector);
            const stateDir =
              process.env.OPENCLAW_STATE_DIR?.trim() ||
              path.join(process.env.HOME ?? homedir(), ".openclaw");
            const auditLogPath = path.join(stateDir, "memory", "refresh-audit.jsonl");
            try {
              await mkdir(path.dirname(auditLogPath), { recursive: true, mode: 0o700 });
              const auditEntry = {
                ts: Date.now(),
                operation: "replaced",
                old_id: memoryId,
                new_id: newEntry.id,
                similarity,
              };
              let preexisting = true;
              try {
                await stat(auditLogPath);
              } catch {
                preexisting = false;
              }
              const handle = await open(auditLogPath, "a", 0o600);
              try {
                await appendFile(handle, `${JSON.stringify(auditEntry)}\n`, "utf8");
              } finally {
                await handle.close();
              }
              if (!preexisting) {
                await chmod(auditLogPath, 0o600);
              }
            } catch (auditError) {
              api.logger.warn(`memory-lancedb: audit log write failed: ${String(auditError)}`);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `Replaced memory ${memoryId.slice(0, 8)}… → ${newEntry.id.slice(0, 8)}…\n\nOld: "${oldTextPreview}"\nNew: "${text.slice(0, 80)}"`,
                },
              ],
              details: {
                operation: "replaced",
                old_id: memoryId,
                new_id: newEntry.id,
                old_text_preview: oldTextPreview,
              },
            };
          });
        },
      };
    },
    { name: "memory_refresh" },
  );
}
