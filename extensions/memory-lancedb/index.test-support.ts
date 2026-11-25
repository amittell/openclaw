import { vi } from "vitest";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";

export function invokeEmbeddingCreate(mock: ReturnType<typeof vi.fn>, body: unknown) {
  return (mock as unknown as (body: unknown) => unknown)(body);
}

export function registerTestPlugin(plugin: { register: (api: never) => void }, api: unknown): void {
  plugin.register(api as never);
}

export function materializeRegisteredTool(
  toolOrFactory: unknown,
  context: Record<string, unknown> = {},
): any {
  return typeof toolOrFactory === "function"
    ? toolOrFactory({ agentId: "main", config: {}, ...context })
    : toolOrFactory;
}

export function createAgentScopedSchemaMock() {
  return vi.fn(async () => ({ fields: [{ name: "agentId" }] }));
}

export function createAgentScopedVectorQuery(limit: ReturnType<typeof vi.fn>) {
  const scopedQuery = { limit };
  return {
    ...scopedQuery,
    where: vi.fn(() => scopedQuery),
  };
}

export function buildMockApiForRefresh(opts: {
  dbPath: string;
  embeddingsCreate: ReturnType<typeof vi.fn>;
  vectorSearch: ReturnType<typeof vi.fn>;
  queryWhere: ReturnType<typeof vi.fn>;
  tableAdd: ReturnType<typeof vi.fn>;
  tableDelete: ReturnType<typeof vi.fn>;
  registeredTools: any[];
}) {
  const pluginConfig = {
    embedding: {
      apiKey: OPENAI_API_KEY,
      model: "text-embedding-3-small",
    },
    dbPath: opts.dbPath,
    autoCapture: false,
    autoRecall: false,
  };
  return {
    id: "memory-lancedb",
    name: "Memory (LanceDB)",
    source: "test",
    config: {},
    pluginConfig,
    // The plugin entry reads live config through api.runtime.config.current() and
    // registers its memory capability unconditionally (v2026.11.5-beta.3).
    runtime: {
      config: {
        current: () => ({ plugins: { entries: { "memory-lancedb": { config: pluginConfig } } } }),
      },
    },
    registerMemoryCapability: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: (tool: any, toolOpts: any) => {
      opts.registeredTools.push({ tool, opts: toolOpts });
    },
    registerCli: vi.fn(),
    registerService: vi.fn(),
    on: vi.fn(),
    resolvePath: (p: string) => p,
  };
}
