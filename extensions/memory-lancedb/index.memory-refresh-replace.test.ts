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
  const { getDbPath, getTmpDir } = installTmpDirHarness({ prefix: "openclaw-memory-test-" });

  afterEach(() => {
    clearMemoryPluginState();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  test("memory_refresh atomic replace: old entry gone, new entry present, audit log written", async () => {
    const existingId = "bbbbbbbb-0000-0000-0000-000000000001";
    const existingEntry = {
      id: existingId,
      text: "Old memory text that will be replaced",
      vector: [0.1, 0.2, 0.3],
      importance: 0.7,
      category: "fact",
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
    const queryWhere = vi.fn(() => ({ toArray }));
    const searchToArray = vi.fn(async () => []);
    const searchLimit = vi.fn(() => ({ toArray: searchToArray }));
    const vectorSearch = vi.fn(() => ({ limit: searchLimit }));

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
            countRows: vi.fn(async () => 1),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    try {
      const { default: memoryPluginUnderTest } = await import("./index.js");
      const registeredTools: any[] = [];

      // Isolate the audit log under the test tmp state dir.
      vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);

      let result: any;
      try {
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

        result = await refreshTool.execute("test-refresh-replace", {
          text: "Updated memory text with new information",
          category: "fact",
          importance: 0.9,
          memoryId: existingId,
        });
      } finally {
        vi.unstubAllEnvs();
      }

      expect(result).toBeDefined();
      expect(result.details.operation).toBe("replaced");
      expect(result.details.old_id).toBe(existingId);
      expect(result.details.new_id).toBeDefined();
      expect(result.details.old_text_preview).toContain("Old memory");

      // Verify delete was called for old entry
      expect(tableDelete).toHaveBeenCalledWith(`(agentId = 'main') AND (id = '${existingId}')`);

      // Verify add was called for new entry
      expect(tableAdd).toHaveBeenCalledTimes(1);
      const addCall = (tableAdd.mock.calls as unknown[][][])[0]?.[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(addCall.text).toBe("Updated memory text with new information");
      expect(addCall.importance).toBe(0.9);

      // Check audit log was written
      const auditLogPath = `${getTmpDir()}/.openclaw/memory/refresh-audit.jsonl`;
      const fsPromises = await import("node:fs/promises");
      const auditContent = await fsPromises.readFile(auditLogPath, "utf8").catch(() => null);
      expect(auditContent).not.toBeNull();
      const auditLine = JSON.parse(auditContent!.trim());
      expect(auditLine.operation).toBe("replaced");
      expect(auditLine.old_id).toBe(existingId);
      expect(auditLine.new_id).toBeDefined();
      // Memory text is intentionally NOT written to audit logs to protect user privacy
      expect(auditLine.old_text).toBeUndefined();
      expect(auditLine.new_text).toBeUndefined();
      expect(auditLine.ts).toBeGreaterThan(0);

      // Audit log directory and file must not be world-readable: the file
      // contains memory ids and timestamps that should not leak across users
      // on shared hosts where the process umask is permissive (e.g. 0o022).
      // On non-POSIX platforms (Windows) mode bits are not meaningfully
      // enforced, so skip the assertion there.
      if (process.platform !== "win32") {
        const fileStat = await fsPromises.stat(auditLogPath);
        expect(fileStat.mode & 0o777).toBe(0o600);
        const dirStat = await fsPromises.stat(`${getTmpDir()}/.openclaw/memory`);
        expect(dirStat.mode & 0o777).toBe(0o700);
      }
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh replace handles typed-array stored vectors from LanceDB", async () => {
    const existingId = "bbbbbbbb-0000-0000-0000-000000000002";
    const existingEntry = {
      id: existingId,
      text: "Old memory text stored with a typed vector",
      vector: new Float32Array([0.1, 0.2, 0.3]),
      importance: 0.7,
      category: "fact",
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() => ({
      limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
    }));

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
            countRows: vi.fn(async () => 1),
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

      const result = await refreshTool.execute("test-refresh-typed-vector", {
        text: "Updated memory text with normalized stored vector",
        memoryId: existingId,
      });

      expect(result.details.operation).toBe("replaced");
      expect(tableDelete).toHaveBeenCalledWith(`(agentId = 'main') AND (id = '${existingId}')`);
      expect(tableAdd).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh best-effort rollback: restores original when insert fails", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);
    const existingId = "dddddddd-0000-0000-0000-000000000001";
    const existingEntry = {
      id: existingId,
      text: "Original memory that must be restored",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "fact",
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() =>
      createAgentScopedVectorQuery(vi.fn(() => ({ toArray: vi.fn(async () => []) }))),
    );

    // First call to add throws (new entry); second call succeeds (rollback restore)
    let addCallCount = 0;
    const tableAdd = vi.fn(async () => {
      addCallCount++;
      if (addCallCount === 1) {
        throw new Error("Simulated insert failure");
      }
      // second call (rollback) succeeds
    });

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
            countRows: vi.fn(async () => 1),
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

      const result = await refreshTool.execute("test-refresh-rollback", {
        text: "New text that will fail to insert",
        memoryId: existingId,
      });

      expect(result.details.operation).toBe("error");
      expect(result.details.error).toBe("insert_failed");
      expect(result.details.rollbackWarning).toContain("restored");

      // Verify delete was called (old entry was removed before the attempted insert)
      expect(tableDelete).toHaveBeenCalledWith(`(agentId = 'main') AND (id = '${existingId}')`);

      // Verify add was called twice: once for new entry (failed), once for rollback (succeeded)
      expect(tableAdd).toHaveBeenCalledTimes(2);

      // Second add call should restore original content with original ID
      const rollbackAddCall = (tableAdd.mock.calls as unknown[][][])[1]?.[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(rollbackAddCall.text).toBe(existingEntry.text);
      expect(rollbackAddCall.importance).toBe(existingEntry.importance);
      expect(rollbackAddCall.category).toBe(existingEntry.category);
      // The rollback must preserve the original ID so callers are never left
      // with a stale reference to a non-existent row.
      expect(rollbackAddCall.id).toBe(existingEntry.id);

      // The return value must expose the restored ID for the caller.
      expect(result.details.restored_id).toBe(existingEntry.id);
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh rollback failure: restored_id is null when both insert and rollback fail", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);
    const existingId = "dddddddd-0000-0000-0000-000000000002";
    const existingEntry = {
      id: existingId,
      text: "Memory that cannot be recovered",
      vector: [0.1, 0.2, 0.3],
      importance: 0.8,
      category: "fact",
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() =>
      createAgentScopedVectorQuery(vi.fn(() => ({ toArray: vi.fn(async () => []) }))),
    );

    // Both insert and rollback fail
    const tableAdd = vi.fn(async () => {
      throw new Error("Simulated storage failure");
    });

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
            countRows: vi.fn(async () => 1),
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

      const result = await refreshTool.execute("test-double-fail", {
        text: "New text that will fail to insert",
        memoryId: existingId,
      });

      expect(result.details.operation).toBe("error");
      expect(result.details.error).toBe("insert_failed");
      expect(result.details.success).toBe(false);
      expect(result.details.rollbackWarning).toContain("DATA LOSS POSSIBLE");
      // When rollback also failed, restored_id must be null — not the original ID.
      expect(result.details.restored_id).toBeNull();
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh replace inherits category and importance from existing when not provided", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);
    const existingId = "eeeeeeee-0000-0000-0000-000000000001";
    const existingEntry = {
      id: existingId,
      text: "Old memory text",
      vector: [0.1, 0.2, 0.3],
      importance: 0.9, // non-default, to verify it is inherited
      category: "decision" as const,
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
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
            countRows: vi.fn(async () => 1),
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

      // Call with only text — omit category and importance entirely.
      const result = await refreshTool.execute("test-refresh-inherit", {
        text: "Updated text only - no category or importance supplied",
        memoryId: existingId,
      });

      expect(result.details.operation).toBe("replaced");

      // The new entry must carry over the original category and importance.
      const addCall = (tableAdd.mock.calls as unknown[][][])[0]?.[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(addCall.text).toBe("Updated text only - no category or importance supplied");
      expect(addCall.category).toBe("decision"); // inherited from existingEntry
      expect(addCall.importance).toBe(0.9); // inherited from existingEntry
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh concurrent replace calls on same ID serialize: operations do not interleave", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);
    const existingId = "ffffffff-0000-0000-0000-000000000001";
    const existingEntry = {
      id: existingId,
      text: "Original text",
      vector: [0.1, 0.2, 0.3],
      importance: 0.7,
      category: "fact",
      createdAt: 1000,
    };

    // Track the order of DB operations across both concurrent calls.
    const callLog: string[] = [];

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));

    // Static mock: getById always returns the same entry regardless of prior deletes.
    const toArray = vi.fn(async () => [existingEntry]);
    const queryWhere = vi.fn(() => ({ toArray }));
    const vectorSearch = vi.fn(() =>
      createAgentScopedVectorQuery(vi.fn(() => ({ toArray: vi.fn(async () => []) }))),
    );

    // tableDelete introduces a small async gap so that without the mutex the
    // two calls' delete operations would both complete before either add fires,
    // producing the interleaved log ["delete","delete","add","add"].
    // With the mutex the expected log is ["delete","add","delete","add"].
    const tableDelete = vi.fn(async () => {
      callLog.push("delete");
      await new Promise<void>((r) => {
        setTimeout(r, 5);
      });
      return { numDeletedRows: 1 };
    });
    const tableAdd = vi.fn(async () => {
      callLog.push("add");
    });

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
            countRows: vi.fn(async () => 1),
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

      // Fire two replace calls simultaneously on the same memoryId.
      const [result1, result2] = await Promise.all([
        refreshTool.execute("concurrent-call-1", { text: "Update A", memoryId: existingId }),
        refreshTool.execute("concurrent-call-2", { text: "Update B", memoryId: existingId }),
      ]);

      // Both calls must complete without throwing.
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();

      // Both succeed because the static mock always returns the entry.
      expect(result1.details.operation).toBe("replaced");
      expect(result2.details.operation).toBe("replaced");

      // Serialized pattern: delete, add, delete, add.
      // Interleaved (racy) pattern would be: delete, delete, add, add.
      // The mutex guarantees the former.
      expect(callLog).toEqual(["delete", "add", "delete", "add"]);
    } finally {
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });

  test("memory_refresh replace preserves the original memoryId across the delete+insert", async () => {
    const existingId = "bbbbbbbb-1111-1111-1111-000000000001";
    const existingEntry = {
      id: existingId,
      text: "Original memory text",
      vector: [0.1, 0.2, 0.3],
      importance: 0.7,
      category: "fact",
      createdAt: 1000,
    };

    const embeddingsCreate = vi.fn(async () => ({
      data: [{ embedding: [0.15, 0.25, 0.35] }],
    }));
    const tableAdd = vi.fn(async () => undefined);
    const tableDelete = vi.fn(async () => ({ numDeletedRows: 1 }));
    const toArray = vi.fn(async () => [existingEntry]);
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
            countRows: vi.fn(async () => 1),
            add: tableAdd,
            delete: tableDelete,
          })),
        })),
      })),
    }));

    const originalHome = process.env.HOME;
    process.env.HOME = getTmpDir();

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

      const result = await refreshTool.execute("test-refresh-id-preserve", {
        text: "Updated memory text with new information",
        memoryId: existingId,
      });

      expect(result.details.operation).toBe("replaced");

      // The stable id MUST survive the replace so callers can keep using
      // whatever reference they cached before the refresh.
      expect(result.details.old_id).toBe(existingId);
      expect(result.details.new_id).toBe(existingId);

      // The new row inserted into the table must carry the same id.
      expect(tableAdd).toHaveBeenCalledTimes(1);
      const addCall = (tableAdd.mock.calls as unknown[][][])[0]?.[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(addCall.id).toBe(existingId);
      expect(addCall.text).toBe("Updated memory text with new information");
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
      vi.doUnmock("openai");
      vi.doUnmock("./lancedb-runtime.js");
      vi.resetModules();
    }
  });
});
