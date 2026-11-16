import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as LanceDB from "@lancedb/lancedb";
import type * as Arrow from "apache-arrow";
import type { FileLockHandle } from "openclaw/plugin-sdk/file-lock";
import type { MemoryCategory } from "./config.js";
import { acquireMemoryTableUsage, withExclusiveMemoryTable } from "./lancedb-custody.js";
import { loadLanceDbModule } from "./lancedb-runtime.js";
import {
  hasAgentScopeColumn,
  hasVisibilityColumn,
  isMemoryVisibility,
  legacyMemorySchemaError,
  memoryAgentPredicate,
  memoryVisibilityPredicate,
  MEMORY_TABLE_NAME,
  MEMORY_VISIBILITY_COLUMN,
  type MemoryVisibility,
  type MemoryVisibilityScope,
  quoteLanceSqlString,
} from "./lancedb-schema.js";

// LanceDB's CJS serializer needs Arrow datatypes from the same module instance.
const { Field, FixedSizeList, Float32, Float64, Schema, Utf8 }: typeof Arrow = createRequire(
  import.meta.url,
)("apache-arrow");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  createdAt: number;
  /** Absent on a table without the visibility column, where every row is `team`. */
  visibility?: MemoryVisibility;
};

type MemoryListEntry = Omit<MemoryEntry, "vector">;

type MemoryScopeOptions = {
  /** Rows this call may see. Defaults to `team`, which hides owner rows. */
  visibilityScope?: MemoryVisibilityScope;
};

type MemoryListOptions = MemoryScopeOptions & {
  orderByCreatedAt?: boolean;
};

export type MemorySearchResult = {
  entry: MemoryEntry;
  score: number;
};

export const MEMORY_QUERY_COLUMNS = [
  "id",
  "text",
  "importance",
  "category",
  "createdAt",
  MEMORY_VISIBILITY_COLUMN,
] as const;
export type MemoryQueryColumn = (typeof MEMORY_QUERY_COLUMNS)[number];
export type MemoryQueryFilter = {
  column: MemoryQueryColumn;
  operator: "=" | "!=" | "<>" | "<" | "<=" | ">" | ">=" | "LIKE";
  value: string | number;
};

type MemoryReadGuard = MemoryScopeOptions & {
  /**
   * Runs once the table is prepared, synchronously before the read is dispatched. A caller
   * whose authority can lapse during that preparation throws here to stop the read.
   */
  beforeRead?: () => void;
};

type MemoryQueryOptions = MemoryReadGuard & {
  columns: MemoryQueryColumn[];
  filter?: MemoryQueryFilter;
  limit?: number;
};

type StoredMemoryRow = MemoryEntry & {
  agentId: string;
};

function createMemoryTableSchema(vectorDim: number): Arrow.Schema {
  return new Schema([
    new Field("id", new Utf8(), true),
    new Field("text", new Utf8(), true),
    new Field("vector", new FixedSizeList(vectorDim, new Field("item", new Float32(), true)), true),
    new Field("importance", new Float64(), true),
    new Field("category", new Utf8(), true),
    new Field("createdAt", new Float64(), true),
    new Field("agentId", new Utf8(), true),
    new Field(MEMORY_VISIBILITY_COLUMN, new Utf8(), true),
  ]);
}

function formatQueryFilter(filter: MemoryQueryFilter): string {
  const value =
    typeof filter.value === "string" ? quoteLanceSqlString(filter.value) : String(filter.value);
  return `${filter.column} ${filter.operator} ${value}`;
}

// LanceDB 0.30 replaces rather than combines repeated where() calls, so agent scope,
// visibility and the operator filter are one predicate and none of them can be lost.
function scopedPredicate(
  agentId: string,
  visibility: string | null,
  filter?: MemoryQueryFilter,
): string {
  const clauses = [
    memoryAgentPredicate(agentId),
    visibility,
    filter ? formatQueryFilter(filter) : null,
  ].filter((clause): clause is string => clause !== null);
  return clauses.length === 1 ? clauses[0]! : clauses.map((clause) => `(${clause})`).join(" AND ");
}

// A NULL tag, or a table without the column, leaves the field off: the row is `team`.
function addVisibility(entry: { visibility?: MemoryVisibility }, value: unknown): void {
  if (isMemoryVisibility(value)) {
    entry.visibility = value;
  }
}

type VisibilityColumnState = { present: true } | { present: false; error: unknown };

// Additive evolution, as Doctor's agentId migration: every existing row reads as `team`,
// so adding the column changes no read. A competing opener can add it first and fail this
// attempt, so the latest schema decides, not this attempt's outcome.
async function addVisibilityColumn(table: LanceDB.Table): Promise<VisibilityColumnState> {
  let error: unknown = new Error("addColumns returned without adding it");
  try {
    await table.addColumns([
      { name: MEMORY_VISIBILITY_COLUMN, valueSql: quoteLanceSqlString("team") },
    ]);
  } catch (caught) {
    error = caught;
    await table.checkoutLatest();
  }
  return hasVisibilityColumn(await table.schema()) ? { present: true } : { present: false, error };
}

export class MemoryDB {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private usage: FileLockHandle | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  // Read from the table at initialization; the plugin never drops the column once added.
  private visibilityColumn: VisibilityColumnState = { present: false, error: undefined };

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
    private readonly storageOptions?: Record<string, string>,
  ) {}

  start(): void {
    if (this.closing) {
      throw new Error("Memory database is still closing");
    }
    this.closed = false;
  }

  private async runOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("Memory database is closed; restart the memory service before using it.");
    }
    const operation = run();
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  private useTable<T>(run: (table: LanceDB.Table) => Promise<T>): Promise<T> {
    return this.runOperation(async () => {
      await this.ensureInitialized();
      return await run(this.table!);
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      // Retained handles need an explicit refresh to observe external commits.
      await this.table.checkoutLatest();
      return;
    }
    if (this.initPromise) {
      return await this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    return await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const usage = await acquireMemoryTableUsage(this.dbPath);
    let db: LanceDB.Connection | null = null;
    let table: LanceDB.Table | null = null;
    try {
      const lancedb = await loadLanceDbModule();
      db = await lancedb.connect(this.dbPath, { storageOptions: this.storageOptions });
      const tables = await db.tableNames();
      // A competing initializer may need to retry startup before its first version is readable.
      table = tables.includes(MEMORY_TABLE_NAME)
        ? await db.openTable(MEMORY_TABLE_NAME)
        : await db.createEmptyTable(MEMORY_TABLE_NAME, createMemoryTableSchema(this.vectorDim), {
            existOk: true,
          });
      const schema = await table.schema();
      if (!hasAgentScopeColumn(schema)) {
        throw legacyMemorySchemaError();
      }
      const visibilityColumn: VisibilityColumnState = hasVisibilityColumn(schema)
        ? { present: true }
        : await addVisibilityColumn(table);

      this.db = db;
      this.table = table;
      this.usage = usage;
      this.visibilityColumn = visibilityColumn;
    } catch (error) {
      table?.close();
      db?.close();
      await usage?.release();
      throw error;
    }
  }

  // Valid only inside useTable, after initialization has read the schema.
  private visibilityClause(scope: MemoryVisibilityScope | undefined): string | null {
    return memoryVisibilityPredicate(scope ?? "team", this.visibilityColumn.present);
  }

  private visibilityUnavailable(): Error {
    const state = this.visibilityColumn;
    const cause = state.present ? undefined : state.error;
    return new Error(
      `memory-lancedb: the memory table has no ${MEMORY_VISIBILITY_COLUMN} column, so no row can be tagged owner. Adding it failed when the table opened: ${String(cause)}`,
      { cause },
    );
  }

  // New and rewritten rows are `team` unless tagged. On a table without the column an
  // owner tag cannot be stored, and storing the row untagged would expose it.
  private storedVisibility(visibility: MemoryVisibility | undefined): {
    visibility?: MemoryVisibility;
  } {
    if (this.visibilityColumn.present) {
      return { visibility: visibility ?? "team" };
    }
    if (visibility === "owner") {
      throw this.visibilityUnavailable();
    }
    return {};
  }

  async store(
    agentId: string,
    entry: Omit<MemoryEntry, "id" | "createdAt">,
    options: { id?: string } = {},
  ): Promise<MemoryEntry> {
    // memory_refresh passes the existing id so a replace preserves the stable
    // identifier callers may have cached. Validate the shape so a malformed id
    // can never reach the SQL filter or the row payload.
    if (options.id !== undefined && !UUID_PATTERN.test(options.id)) {
      throw new Error(`Invalid memory ID format: ${options.id}`);
    }
    const { visibility, ...fields } = entry;
    return await this.useTable(async (table) => {
      const fullEntry: MemoryEntry = {
        ...fields,
        id: options.id ?? randomUUID(),
        createdAt: Date.now(),
        ...this.storedVisibility(visibility),
      };
      const storedEntry: StoredMemoryRow = { ...fullEntry, agentId };
      await table.add([storedEntry]);
      return fullEntry;
    });
  }

  async search(
    agentId: string,
    vector: number[],
    limit = 5,
    minScore = 0.5,
    options?: Pick<LanceDB.QueryExecutionOptions, "timeoutMs"> & MemoryReadGuard,
  ): Promise<MemorySearchResult[]> {
    // LanceDB applies metadata predicates before vector ranking. Foreign rows, and
    // owner rows for a team-scoped read, must never enter the candidate set or top-K.
    const results = await this.useTable((table) => {
      options?.beforeRead?.();
      return table
        .vectorSearch(vector)
        .where(scopedPredicate(agentId, this.visibilityClause(options?.visibilityScope)))
        .limit(limit)
        .toArray(options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs });
    });

    const mapped = results.map((row) => {
      const distance = row["_distance"] ?? 0;
      const score = 1 / (1 + distance);
      const entry: MemoryEntry = {
        id: row.id as string, // SAFETY: column declared by createMemoryTableSchema.
        text: row.text as string, // SAFETY: column declared by createMemoryTableSchema.
        vector: row.vector as number[], // SAFETY: column declared by createMemoryTableSchema.
        importance: row.importance as number, // SAFETY: column declared by createMemoryTableSchema.
        category: row.category as MemoryEntry["category"], // SAFETY: category is written only by store(), which takes it from MemoryEntry.
        createdAt: row.createdAt as number, // SAFETY: column declared by createMemoryTableSchema.
      };
      addVisibility(entry, row[MEMORY_VISIBILITY_COLUMN]);
      return { entry, score };
    });

    return mapped.filter((result) => result.score >= minScore);
  }

  async list(
    agentId: string,
    limit?: number,
    options: MemoryListOptions = {},
  ): Promise<MemoryListEntry[]> {
    const rows = await this.query(agentId, {
      columns: [...MEMORY_QUERY_COLUMNS],
      limit: options.orderByCreatedAt ? undefined : limit,
      visibilityScope: options.visibilityScope,
    });
    const entries = rows.map((row) => {
      const entry: MemoryListEntry = {
        id: row.id as string, // SAFETY: column declared by createMemoryTableSchema.
        text: row.text as string, // SAFETY: column declared by createMemoryTableSchema.
        importance: row.importance as number, // SAFETY: column declared by createMemoryTableSchema.
        category: row.category as MemoryEntry["category"], // SAFETY: category is written only by store(), which takes it from MemoryEntry.
        createdAt: row.createdAt as number, // SAFETY: column declared by createMemoryTableSchema.
      };
      addVisibility(entry, row[MEMORY_VISIBILITY_COLUMN]);
      return entry;
    });
    if (options.orderByCreatedAt) {
      entries.sort((a, b) => b.createdAt - a.createdAt);
    }

    return limit === undefined ? entries : entries.slice(0, limit);
  }

  async query(agentId: string, options: MemoryQueryOptions): Promise<Record<string, unknown>[]> {
    return await this.useTable(async (table) => {
      options.beforeRead?.();
      // A table without the column cannot answer for it: its rows are all `team`.
      if (!this.visibilityColumn.present && options.filter?.column === MEMORY_VISIBILITY_COLUMN) {
        throw this.visibilityUnavailable();
      }
      const columns = this.visibilityColumn.present
        ? options.columns
        : options.columns.filter((column) => column !== MEMORY_VISIBILITY_COLUMN);
      let query = table
        .query()
        .where(
          scopedPredicate(agentId, this.visibilityClause(options.visibilityScope), options.filter),
        )
        .select(columns);
      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }
      return (await query.toArray()) as Record<string, unknown>[]; // SAFETY: toArray yields plain row records keyed by the column names selected above.
    });
  }

  async delete(agentId: string, id: string, options: MemoryScopeOptions = {}): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const filter: MemoryQueryFilter = { column: "id", operator: "=", value: id };
    const result = await this.useTable((table) =>
      table.delete(
        scopedPredicate(agentId, this.visibilityClause(options.visibilityScope), filter),
      ),
    );
    return result.numDeletedRows > 0;
  }

  async getById(
    agentId: string,
    id: string,
    options: MemoryScopeOptions = {},
  ): Promise<MemoryEntry | null> {
    if (!UUID_PATTERN.test(id)) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }
    const filter: MemoryQueryFilter = { column: "id", operator: "=", value: id };
    const rows = await this.useTable((table) =>
      table
        .query()
        .where(scopedPredicate(agentId, this.visibilityClause(options.visibilityScope), filter))
        .toArray(),
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const entry: MemoryEntry = {
      id: row.id as string, // SAFETY: column declared Utf8 by createMemoryTableSchema.
      text: row.text as string, // SAFETY: column declared Utf8 by createMemoryTableSchema.
      vector: Array.from(row.vector as ArrayLike<number>), // SAFETY: fixed-size Float32 list column.
      importance: row.importance as number, // SAFETY: column declared Float64.
      category: row.category as MemoryEntry["category"], // SAFETY: category is written only by store().
      createdAt: row.createdAt as number, // SAFETY: column declared Float64.
    };
    addVisibility(entry, row[MEMORY_VISIBILITY_COLUMN]);
    return entry;
  }

  // Raw re-insert that preserves the caller-supplied id/createdAt. Only for
  // memory_refresh rollback, where the original entry must come back under
  // its original id so callers never hold a stale reference.
  async storeRaw(agentId: string, entry: MemoryEntry): Promise<MemoryEntry> {
    const { visibility, ...fields } = entry;
    await this.useTable((table) =>
      table.add([{ ...fields, ...this.storedVisibility(visibility), agentId }]),
    );
    return entry;
  }

  /** Tags rows by id for an operator; returns how many rows were updated. */
  async setVisibility(
    agentId: string,
    ids: readonly string[],
    visibility: MemoryVisibility,
  ): Promise<number> {
    if (!isMemoryVisibility(visibility)) {
      throw new Error(`Invalid memory visibility: ${String(visibility)}`);
    }
    for (const id of ids) {
      if (!UUID_PATTERN.test(id)) {
        throw new Error(`Invalid memory ID format: ${id}`);
      }
    }
    return await this.useTable(async (table) => {
      if (!this.visibilityColumn.present) {
        throw this.visibilityUnavailable();
      }
      if (ids.length === 0) {
        return 0;
      }
      // The operator chose these rows, so no visibility clause: re-tagging either way works.
      const idList = ids.map((id) => quoteLanceSqlString(id)).join(", ");
      const result = await table.update({
        where: `(${memoryAgentPredicate(agentId)}) AND (id IN (${idList}))`,
        valuesSql: { [MEMORY_VISIBILITY_COLUMN]: quoteLanceSqlString(visibility) },
      });
      return result.rowsUpdated;
    });
  }

  async optimize(assertCurrent: () => void = () => {}): Promise<{
    before: { rows: number; fragments: number };
    after: { rows: number; fragments: number };
  }> {
    return await this.runOperation(() =>
      withExclusiveMemoryTable(this.dbPath, async () => {
        const lancedb = await loadLanceDbModule();
        const connection = await lancedb.connect(this.dbPath, {
          storageOptions: this.storageOptions,
        });
        let table: LanceDB.Table | null = null;
        try {
          assertCurrent();
          if (!(await connection.tableNames()).includes(MEMORY_TABLE_NAME)) {
            return { before: { rows: 0, fragments: 0 }, after: { rows: 0, fragments: 0 } };
          }
          table = await connection.openTable(MEMORY_TABLE_NAME);
          const before = await table.stats();
          assertCurrent();
          // The default prunes seven-day-old versions. Preserve all version history.
          await table.optimize({ cleanupOlderThan: new Date(0), deleteUnverified: false });
          const after = await table.stats();
          if (after.numRows !== before.numRows) {
            throw new Error(
              `Memory row count changed during optimization: ${before.numRows} -> ${after.numRows}`,
            );
          }
          return {
            before: { rows: before.numRows, fragments: before.fragmentStats.numFragments },
            after: { rows: after.numRows, fragments: after.fragmentStats.numFragments },
          };
        } finally {
          table?.close();
          connection.close();
        }
      }),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      // Native calls are not cancellable; retain custody until accepted work settles.
      await Promise.allSettled(this.pending);
      this.table?.close();
      this.db?.close();
      this.table = null;
      this.db = null;
      this.initPromise = null;
      await this.usage?.release();
      this.usage = null;
    })().finally(() => {
      this.closing = null;
    });
    return this.closing;
  }
}
