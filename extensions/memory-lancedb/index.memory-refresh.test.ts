import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, test, expect, vi } from "vitest";
import {
  buildMockApiForRefresh,
  createAgentScopedSchemaMock,
  createAgentScopedVectorQuery,
  invokeEmbeddingCreate,
  materializeRegisteredTool,
  registerTestPlugin,
} from "./index.test-support.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("memory plugin e2e", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-test-" });

  afterEach(() => {
    clearMemoryPluginState();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("memory_refresh search-only mode returns matches without writing to DB", async () => {
    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));

    const mockSearchResults = [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        text: "Match one",
        vector: [0.1, 0.2, 0.3],
        importance: 0.8,
        category: "fact",
        createdAt: 1000,
        _distance: 0.05,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        text: "Match two",
        vector: [0.1, 0.2, 0.3],
        importance: 0.7,
        category: "preference",
        createdAt: 1001,
        _distance: 0.1,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000003",
        text: "Match three",
        vector: [0.1, 0.2, 0.3],
        importance: 0.6,
        category: "other",
        createdAt: 1002,
        _distance: 0.2,
      },
    ];

    const toArray = vi.fn(async () => mockSearchResults);
    const limit = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() => createAgentScopedVectorQuery(limit));
    const queryWhere = vi.fn();

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        post = vi.fn((_path: string, opts: { body?: unknown }) =>
          invokeEmbeddingCreate(embeddingsCreate, opts.body),
        );
      },
    }));
    vi.doMock("./lancedb-runtime.js", () => ({
      loadLanceDbModule: vi.fn(async () => ({
        connect: vi.fn(async () => ({
          tableNames: vi.fn(async () => ["memories"]),
          openTable: vi.fn(async () => ({
            schema: createAgentScopedSchemaMock(),
            checkoutLatest: vi.fn(async () => undefined),
            vectorSearch,
            query: vi.fn(() => ({ where: queryWhere })),
            countRows: vi.fn(async () => 3),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    try {
      const { default: memoryPluginUnderTest } = await import("./index.js");
      const registeredTools: any[] = [];
      const mockApi = buildMockApiForRefresh({
        dbPath: getDbPath(),
        embeddingsCreate,
        vectorSearch,
        queryWhere,
        tableAdd,
        tableDelete,
        registeredTools,
      });
      registerTestPlugin(memoryPluginUnderTest, mockApi);

      const refreshTool = materializeRegisteredTool(
        registeredTools.find((t) => t.opts?.name === "memory_refresh")?.tool,
      );
      if (!refreshTool) {
        throw new Error("expected memory_refresh tool registration");
      }
      expect(refreshTool.execute).toBeTypeOf("function");

      // Call without memoryId → search-only mode
      const result = await refreshTool.execute("test-refresh-search", {
        text: "user prefers dark theme",
      });

      expect(result.details.operation).toBe("search_only");
      expect(result.details.matches).toHaveLength(3);
      const matches = result.details.matches as Array<Record<string, unknown>>;
      expect(matches[0]).toHaveProperty("similarity");
      expect(matches[0]?.similarity).toBeGreaterThan(0);

      // Verify nothing was written to the DB
      expect(tableAdd).not.toHaveBeenCalled();
      expect(tableDelete).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh replace with non-existent ID returns error without creating entry", async () => {
    const nonExistentId = "cccccccc-0000-0000-0000-000000000001";

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => []); // empty → not found
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() =>
      createAgentScopedVectorQuery(vi.fn(() => ({ toArray: vi.fn(async () => []) }))),
    );

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        post = vi.fn((_path: string, opts: { body?: unknown }) =>
          invokeEmbeddingCreate(embeddingsCreate, opts.body),
        );
      },
    }));
    vi.doMock("./lancedb-runtime.js", () => ({
      loadLanceDbModule: vi.fn(async () => ({
        connect: vi.fn(async () => ({
          tableNames: vi.fn(async () => ["memories"]),
          openTable: vi.fn(async () => ({
            schema: createAgentScopedSchemaMock(),
            checkoutLatest: vi.fn(async () => undefined),
            vectorSearch,
            query: vi.fn(() => ({ where: queryWhere })),
            countRows: vi.fn(async () => 0),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    try {
      const { default: memoryPluginUnderTest } = await import("./index.js");
      const registeredTools: any[] = [];
      const mockApi = buildMockApiForRefresh({
        dbPath: getDbPath(),
        embeddingsCreate,
        vectorSearch,
        queryWhere,
        tableAdd,
        tableDelete,
        registeredTools,
      });
      registerTestPlugin(memoryPluginUnderTest, mockApi);

      const refreshTool = materializeRegisteredTool(
        registeredTools.find((t) => t.opts?.name === "memory_refresh")?.tool,
      );
      if (!refreshTool) {
        throw new Error("expected memory_refresh tool registration");
      }
      expect(refreshTool.execute).toBeTypeOf("function");

      const result = await refreshTool.execute("test-refresh-notfound", {
        text: "This text won't be stored",
        memoryId: nonExistentId,
      });

      expect(result.details.operation).toBe("error");
      expect(result.details.error).toBe("not_found");
      expect(result.details.memoryId).toBe(nonExistentId);

      // Verify nothing was written or deleted
      expect(tableAdd).not.toHaveBeenCalled();
      expect(tableDelete).not.toHaveBeenCalled();

      // Verify the embedding API was not called — a stale/invalid memoryId
      // should short-circuit before incurring an embedding round-trip.
      expect(embeddingsCreate).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh description avoids unqualified 'atomic' framing", async () => {
    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => []);
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() =>
      createAgentScopedVectorQuery(vi.fn(() => ({ toArray: vi.fn(async () => []) }))),
    );

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        post = vi.fn((_path: string, opts: { body?: unknown }) =>
          invokeEmbeddingCreate(embeddingsCreate, opts.body),
        );
      },
    }));
    vi.doMock("./lancedb-runtime.js", () => ({
      loadLanceDbModule: vi.fn(async () => ({
        connect: vi.fn(async () => ({
          tableNames: vi.fn(async () => ["memories"]),
          openTable: vi.fn(async () => ({
            schema: createAgentScopedSchemaMock(),
            checkoutLatest: vi.fn(async () => undefined),
            vectorSearch,
            query: vi.fn(() => ({ where: queryWhere })),
            countRows: vi.fn(async () => 0),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    try {
      const { default: memoryPluginUnderTest } = await import("./index.js");
      const registeredTools: any[] = [];
      const mockApi = buildMockApiForRefresh({
        dbPath: getDbPath(),
        embeddingsCreate,
        vectorSearch,
        queryWhere,
        tableAdd,
        tableDelete,
        registeredTools,
      });
      registerTestPlugin(memoryPluginUnderTest, mockApi);

      const refreshTool = materializeRegisteredTool(
        registeredTools.find((t) => t.opts?.name === "memory_refresh")?.tool,
      );
      if (!refreshTool) {
        throw new Error("expected memory_refresh tool registration");
      }
      const description = refreshTool.description as string;

      // The tool description must not promise atomicity it cannot deliver.
      // Match "atomic" or "atomically" as standalone words so future copy
      // changes that legitimately introduce a qualified phrase (for example
      // "best-effort, not storage-level atomic") still fail this test until
      // they are wired up to a real transactional implementation.
      expect(description.toLowerCase()).not.toMatch(/\batomic(ally)?\b/);

      // And it must say what the replace path actually does so callers are
      // not surprised by the lack of a storage-level transaction.
      expect(description.toLowerCase()).toContain("best-effort");

      // The memoryId parameter help text must not promise atomicity either.
      const paramsSchema = refreshTool.parameters as {
        properties?: { memoryId?: { description?: string } };
      };
      const memoryIdDescription = paramsSchema.properties?.memoryId?.description ?? "";
      expect(memoryIdDescription.toLowerCase()).not.toMatch(/\batomic(ally)?\b/);
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh conflict preview filters out low-similarity matches (threshold >= 0.5)", async () => {
    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));

    // Mix three rows: one above the 0.5 threshold (_distance=0.05 -> 0.952),
    // one above (_distance=0.5 -> 0.667), and one BELOW (_distance=2.0 -> 0.333).
    // Under the old 0.1 threshold all three would pass; under the new 0.5
    // threshold the third row is filtered out as a poor replacement candidate.
    const mockRows = [
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        text: "Highly relevant near-duplicate",
        vector: [0.1, 0.2, 0.3],
        importance: 0.8,
        category: "fact",
        createdAt: 1000,
        _distance: 0.05,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000002",
        text: "Moderately relevant",
        vector: [0.1, 0.2, 0.3],
        importance: 0.7,
        category: "preference",
        createdAt: 1001,
        _distance: 0.5,
      },
      {
        id: "aaaaaaaa-0000-0000-0000-000000000003",
        text: "Tangentially related (should be filtered by the stricter threshold)",
        vector: [0.1, 0.2, 0.3],
        importance: 0.4,
        category: "other",
        createdAt: 1002,
        _distance: 2,
      },
    ];

    const toArray = vi.fn(async () => mockRows);
    const limit = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() => createAgentScopedVectorQuery(limit));
    const queryWhere = vi.fn();

    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        post = vi.fn((_path: string, opts: { body?: unknown }) =>
          invokeEmbeddingCreate(embeddingsCreate, opts.body),
        );
      },
    }));
    vi.doMock("./lancedb-runtime.js", () => ({
      loadLanceDbModule: vi.fn(async () => ({
        connect: vi.fn(async () => ({
          tableNames: vi.fn(async () => ["memories"]),
          openTable: vi.fn(async () => ({
            schema: createAgentScopedSchemaMock(),
            checkoutLatest: vi.fn(async () => undefined),
            vectorSearch,
            query: vi.fn(() => ({ where: queryWhere })),
            countRows: vi.fn(async () => 3),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    try {
      const { default: memoryPluginUnderTest } = await import("./index.js");
      const registeredTools: any[] = [];
      const mockApi = buildMockApiForRefresh({
        dbPath: getDbPath(),
        embeddingsCreate,
        vectorSearch,
        queryWhere,
        tableAdd,
        tableDelete,
        registeredTools,
      });
      registerTestPlugin(memoryPluginUnderTest, mockApi);

      const refreshTool = materializeRegisteredTool(
        registeredTools.find((t) => t.opts?.name === "memory_refresh")?.tool,
      );
      if (!refreshTool) {
        throw new Error("expected memory_refresh tool registration");
      }
      expect(refreshTool.execute).toBeTypeOf("function");

      const result = await refreshTool.execute("test-refresh-threshold", {
        text: "candidate replacement text",
      });

      // Search-only mode is unchanged; only the threshold tightened.
      expect(result.details.operation).toBe("search_only");

      const matches = result.details.matches as Array<{
        id: string;
        similarity: number;
      }>;

      // Every surfaced match must clear the new threshold; the low-similarity
      // tangential row (_distance=2.0 -> score ~0.333) must be dropped.
      for (const m of matches) {
        expect(m.similarity).toBeGreaterThanOrEqual(0.5);
      }
      const ids = matches.map((m) => m.id);
      expect(ids).not.toContain("aaaaaaaa-0000-0000-0000-000000000003");

      // No DB writes in search-only mode.
      expect(tableAdd).not.toHaveBeenCalled();
      expect(tableDelete).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });
});
