import * as lancedb from "@lancedb/lancedb";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildMockApiForRefresh,
  invokeEmbeddingCreate,
  materializeRegisteredTool,
  registerTestPlugin,
} from "./index.test-support.js";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

const fact = { importance: 0.7, category: "fact" as const };
const sortedTexts = (values: unknown[]) =>
  values.map(String).toSorted((left, right) => left.localeCompare(right));

async function createPreVisibilityTable(dbPath: string, rows: Array<Record<string, unknown>>) {
  const connection = await lancedb.connect(dbPath);
  const table = await connection.createTable("memories", rows);
  table.close();
  connection.close();
}

describe("memory visibility in the store", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-visibility-" });

  test("an existing table gains the column at open and team reads never return owner rows", async () => {
    await createPreVisibilityTable(getDbPath(), [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        text: "existing memory",
        vector: [1, 0],
        createdAt: 1,
        agentId: "main",
        ...fact,
      },
    ]);
    const db = new MemoryDB(getDbPath(), 2);
    try {
      const shared = await db.store("main", { text: "shared fact", vector: [1, 0], ...fact });
      const personal = await db.store("main", { text: "owner fact", vector: [1, 0], ...fact });
      expect(await db.setVisibility("main", [personal.id], "owner")).toBe(1);
      expect(
        await db.setVisibility("main", ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], "owner"),
      ).toBe(0);

      const tags = await db.list("main", undefined, { visibilityScope: "owner" });
      expect(Object.fromEntries(tags.map((row) => [row.text, row.visibility]))).toEqual({
        "existing memory": "team",
        "shared fact": "team",
        "owner fact": "owner",
      });

      const texts = (rows: Array<{ text?: unknown }>) => sortedTexts(rows.map((row) => row.text));
      const team = { visibilityScope: "team" } as const;
      const owner = { visibilityScope: "owner" } as const;
      const searchTexts = async (options?: typeof team | typeof owner) =>
        sortedTexts((await db.search("main", [1, 0], 5, 0, options)).map((hit) => hit.entry.text));
      // The default scope is team.
      expect(await searchTexts()).toEqual(["existing memory", "shared fact"]);
      expect(await searchTexts(team)).toEqual(["existing memory", "shared fact"]);
      expect(await searchTexts(owner)).toEqual(["existing memory", "owner fact", "shared fact"]);
      expect(texts(await db.list("main"))).toEqual(["existing memory", "shared fact"]);
      expect(texts(await db.query("main", { columns: ["text"], ...team }))).toEqual([
        "existing memory",
        "shared fact",
      ]);
      expect(
        texts(
          await db.query("main", {
            columns: ["text"],
            filter: { column: "visibility", operator: "=", value: "owner" },
            ...owner,
          }),
        ),
      ).toEqual(["owner fact"]);
      expect(await db.getById("main", personal.id)).toBeNull();
      expect((await db.getById("main", personal.id, owner))?.visibility).toBe("owner");
      expect(await db.delete("main", personal.id)).toBe(false);

      await db.setVisibility("main", [personal.id], "team");
      expect(await searchTexts()).toEqual(["existing memory", "owner fact", "shared fact"]);
      expect(shared.visibility).toBe("team");
    } finally {
      await db.close();
    }
  });

  test("an owner tag stays inside its agent's rows", async () => {
    const db = new MemoryDB(getDbPath(), 2);
    try {
      await db.store("alpha", {
        text: "alpha owner",
        vector: [1, 0],
        visibility: "owner",
        ...fact,
      });
      await db.store("beta", { text: "beta shared", vector: [1, 0], ...fact });
      for (const visibilityScope of ["team", "owner"] as const) {
        const hits = await db.search("beta", [1, 0], 5, 0, { visibilityScope });
        expect(hits.map((hit) => hit.entry.text)).toEqual(["beta shared"]);
      }
      expect((await db.search("alpha", [1, 0], 5, 0, { visibilityScope: "team" })).length).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe("memory visibility through the memory tools", () => {
  const { getDbPath, getTmpDir } = installTmpDirHarness({ prefix: "openclaw-memory-vis-tools-" });

  afterEach(() => {
    clearMemoryPluginState();
    vi.unstubAllEnvs();
    vi.doUnmock("openai");
  });

  test("a non-owner turn cannot recall, forget or refresh an owner row; the owner can", async () => {
    // text-embedding-3-small is 1536-dimensional; every vector is the same unit vector.
    const unit = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));
    const embeddingsCreate = vi.fn(async () => ({ data: [{ embedding: unit }] }));
    vi.resetModules();
    vi.doMock("openai", () => ({
      default: class MockOpenAI {
        post = vi.fn((_path: string, opts: { body?: unknown }) =>
          invokeEmbeddingCreate(embeddingsCreate, opts.body),
        );
      },
    }));
    vi.stubEnv("OPENCLAW_STATE_DIR", `${getTmpDir()}/.openclaw`);

    const seed = new MemoryDB(getDbPath(), unit.length);
    const shared = await seed.store("main", { text: "team fact", vector: unit, ...fact });
    const personal = await seed.store("main", {
      text: "owner fact",
      vector: unit,
      visibility: "owner",
      ...fact,
    });

    const { default: memoryPlugin } = await import("./index.js");
    const registeredTools: Array<{ tool: unknown; opts?: { name?: string } }> = [];
    const mockApi = buildMockApiForRefresh({
      dbPath: getDbPath(),
      embeddingsCreate,
      vectorSearch: vi.fn(),
      queryWhere: vi.fn(),
      tableAdd: vi.fn(),
      tableDelete: vi.fn(),
      registeredTools,
    });
    registerTestPlugin(memoryPlugin, mockApi);
    const tool = (name: string, senderIsOwner?: boolean) =>
      materializeRegisteredTool(
        registeredTools.find((entry) => entry.opts?.name === name)?.tool,
        senderIsOwner === undefined ? {} : { senderIsOwner },
      );
    const recalled = async (senderIsOwner?: boolean) =>
      (
        (await tool("memory_recall", senderIsOwner).execute("recall", { query: "fact" })).details
          .memories as Array<{ text: string }>
      )
        .map((memory) => memory.text)
        .toSorted((left, right) => left.localeCompare(right));

    try {
      expect(await recalled()).toEqual(["team fact"]);
      expect(await recalled(false)).toEqual(["team fact"]);
      expect(await recalled(true)).toEqual(["owner fact", "team fact"]);

      const refreshAsGuest = await tool("memory_refresh", false).execute("refresh", {
        text: "rewritten by a guest",
        memoryId: personal.id,
      });
      expect(refreshAsGuest.details).toMatchObject({ error: "not_found" });
      const refreshAsOwner = await tool("memory_refresh", true).execute("refresh", {
        text: "owner fact, updated",
        memoryId: personal.id,
      });
      expect(refreshAsOwner.details).toMatchObject({ operation: "replaced" });
      expect(await seed.getById("main", personal.id, { visibilityScope: "owner" })).toMatchObject({
        text: "owner fact, updated",
        visibility: "owner",
      });

      const forgetAsGuest = await tool("memory_forget", false).execute("forget", {
        memoryId: personal.id,
      });
      expect(forgetAsGuest.details).toMatchObject({ action: "not_found" });
      expect(await recalled(true)).toEqual(["owner fact, updated", "team fact"]);
      const forgetAsOwner = await tool("memory_forget", true).execute("forget", {
        memoryId: personal.id,
      });
      expect(forgetAsOwner.details).toMatchObject({ action: "deleted", id: personal.id });
      expect(await recalled(true)).toEqual(["team fact"]);
      expect(shared.visibility).toBe("team");
    } finally {
      const service = (mockApi.registerService as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
      await service?.stop?.();
      await seed.close();
    }
  });
});
