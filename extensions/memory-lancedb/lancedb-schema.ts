export const MEMORY_TABLE_NAME = "memories";
export const MEMORY_AGENT_ID_COLUMN = "agentId";

// Rows tagged `owner` are hidden from every `team`-scoped read. A NULL tag, or a
// table that has no visibility column yet, means `team`.
export const MEMORY_VISIBILITY_COLUMN = "visibility";
export type MemoryVisibility = "team" | "owner";
/** Which rows a read may return: `team` hides owner rows, `owner` returns every row. */
export type MemoryVisibilityScope = "team" | "owner";

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

export function isMemoryVisibility(value: unknown): value is MemoryVisibility {
  return value === "team" || value === "owner";
}

/**
 * Owner rows reach the owner's direct chat, which the host marks with the `owner-private`
 * memory audience. `ownerRecallInGroups` also admits the owner's own turns in group and
 * channel chats, where the reply is visible to everyone there. Both facts come from the
 * runtime's inbound context, never from a tool argument the model controls.
 */
export function memoryVisibilityScopeForCaller(
  caller: { senderIsOwner?: boolean; memoryAudience?: { kind: string } },
  config: { ownerRecallInGroups?: boolean },
): MemoryVisibilityScope {
  if (caller.memoryAudience?.kind === "owner-private") {
    return "owner";
  }
  return config.ownerRecallInGroups === true && caller.senderIsOwner === true ? "owner" : "team";
}

export function quoteLanceSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function memoryAgentPredicate(agentId: string): string {
  return `${MEMORY_AGENT_ID_COLUMN} = ${quoteLanceSqlString(agentId)}`;
}

/**
 * The clause a `team`-scoped read adds, or null when it needs none: the `owner` scope
 * reads every row, and a table without the column cannot hold an owner row.
 */
export function memoryVisibilityPredicate(
  scope: MemoryVisibilityScope,
  columnPresent: boolean,
): string | null {
  if (scope === "owner" || !columnPresent) {
    return null;
  }
  return `${MEMORY_VISIBILITY_COLUMN} IS NULL OR ${MEMORY_VISIBILITY_COLUMN} = ${quoteLanceSqlString("team")}`;
}

export function hasAgentScopeColumn(schema: { fields: Array<{ name: string }> }): boolean {
  return schema.fields.some((field) => field.name === MEMORY_AGENT_ID_COLUMN);
}

export function hasVisibilityColumn(schema: { fields: Array<{ name: string }> }): boolean {
  return schema.fields.some((field) => field.name === MEMORY_VISIBILITY_COLUMN);
}

export function legacyMemorySchemaError(): Error {
  return new Error(
    'memory-lancedb: the existing memory table predates per-agent isolation. Run "openclaw doctor --fix" to assign legacy rows to the default agent, then restart OpenClaw.',
  );
}
