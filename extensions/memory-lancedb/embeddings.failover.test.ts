import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { MemoryConfig } from "./config.js";

const openAiMocks = vi.hoisted(() => ({
  /** baseURL -> handler, so each attempt is attributable to one endpoint. */
  handlers: new Map<string, (timeoutMs?: number) => Promise<unknown>>(),
  calls: [] as Array<{ baseURL: string; timeoutMs?: number }>,
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    constructor(private options: { apiKey: string; baseURL?: string }) {}
    post = async (_path: string, init: { timeout?: number }) => {
      const baseURL = this.options.baseURL ?? "";
      openAiMocks.calls.push({ baseURL, timeoutMs: init.timeout });
      const handler = openAiMocks.handlers.get(baseURL);
      if (!handler) {
        throw new Error(`unexpected embedding endpoint: ${baseURL}`);
      }
      return await handler(init.timeout);
    };
  },
}));

const { createEmbeddings } = await import("./embeddings.js");

const PRIMARY = "http://primary.test/v1";
const FALLBACK = "http://fallback.test/v1";

function createApi(): OpenClawPluginApi {
  const config = {};
  return {
    config,
    runtime: {
      config: { current: () => config },
      agent: { resolveAgentDir: () => "/tmp/openclaw-agent" },
    },
  } as unknown as OpenClawPluginApi;
}

function embeddingConfig(overrides: Partial<MemoryConfig["embedding"]> = {}) {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "text-embedding-3-small",
    baseUrl: PRIMARY,
    fallbackBaseUrl: FALLBACK,
    ...overrides,
  } as MemoryConfig["embedding"];
}

function vectorResponse(value: number) {
  return { data: [{ embedding: [value, value, value] }] };
}

function endpointDown() {
  return Promise.reject(new Error("ECONNREFUSED"));
}

beforeEach(() => {
  openAiMocks.handlers.clear();
  openAiMocks.calls.length = 0;
});

describe("memory-lancedb embedding endpoint failover", () => {
  it("uses only the primary when no fallback is configured", async () => {
    openAiMocks.handlers.set(PRIMARY, async () => vectorResponse(1));
    const embeddings = createEmbeddings(createApi());

    const vector = await embeddings.embed(
      "main",
      "hello",
      embeddingConfig({ fallbackBaseUrl: undefined }),
    );

    expect(vector).toEqual([1, 1, 1]);
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([PRIMARY]);
  });

  it("fails over to the fallback endpoint when the primary is unreachable", async () => {
    openAiMocks.handlers.set(PRIMARY, endpointDown);
    openAiMocks.handlers.set(FALLBACK, async () => vectorResponse(2));
    const embeddings = createEmbeddings(createApi());

    const vector = await embeddings.embed("main", "hello", embeddingConfig());

    expect(vector).toEqual([2, 2, 2]);
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([PRIMARY, FALLBACK]);
  });

  it("skips an endpoint that is still inside its failure cooldown", async () => {
    openAiMocks.handlers.set(PRIMARY, endpointDown);
    openAiMocks.handlers.set(FALLBACK, async () => vectorResponse(3));
    const embeddings = createEmbeddings(createApi());

    await embeddings.embed("main", "first", embeddingConfig());
    openAiMocks.calls.length = 0;
    await embeddings.embed("main", "second", embeddingConfig());

    // The primary is cooling down, so the second call goes straight to the fallback.
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([FALLBACK]);
  });

  it("splits the caller's timeout budget across candidate endpoints", async () => {
    openAiMocks.handlers.set(PRIMARY, endpointDown);
    openAiMocks.handlers.set(FALLBACK, async () => vectorResponse(4));
    const embeddings = createEmbeddings(createApi());

    await embeddings.embed("main", "hello", embeddingConfig(), 10_000);

    // Two candidates share the 10s budget, so neither can consume it all.
    expect(openAiMocks.calls.map((c) => c.timeoutMs)).toEqual([5000, 5000]);
  });

  it("does not burn the fallback on a rejected-dimensions request shape", async () => {
    const dimensionsRejected = Object.assign(new Error("unknown_parameter: dimensions"), {
      status: 400,
    });
    openAiMocks.handlers.set(PRIMARY, async () => {
      throw dimensionsRejected;
    });
    // Second attempt on the primary is the retry without `dimensions`.
    const embeddings = createEmbeddings(createApi());

    await expect(
      embeddings.embed("main", "hello", embeddingConfig({ dimensions: 256 })),
    ).rejects.toThrow(/dimensions/);

    // Both attempts stay on the primary (the second is the retry without
    // `dimensions`); a bad request shape must never consume the fallback.
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([PRIMARY, PRIMARY]);
    expect(openAiMocks.calls.some((c) => c.baseURL === FALLBACK)).toBe(false);
  });

  it("surfaces the last error when every endpoint fails", async () => {
    const lastError = Object.assign(new Error("fallback exploded", { cause: new Error("EPIPE") }), {
      status: 503,
    });
    openAiMocks.handlers.set(PRIMARY, endpointDown);
    openAiMocks.handlers.set(FALLBACK, async () => {
      throw lastError;
    });
    const embeddings = createEmbeddings(createApi());

    await expect(embeddings.embed("main", "hello", embeddingConfig())).rejects.toBe(lastError);
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([PRIMARY, FALLBACK]);
  });

  it.each([
    { name: "string", failure: "fallback unavailable" },
    {
      name: "error record",
      failure: { message: "fallback unavailable", status: 503, code: "EHOSTUNREACH" },
    },
  ])("normalizes the last $name failure without losing details", async ({ failure }) => {
    openAiMocks.handlers.set(PRIMARY, endpointDown);
    openAiMocks.handlers.set(FALLBACK, () => Promise.reject(failure));
    const embeddings = createEmbeddings(createApi());

    const result = embeddings.embed("main", "hello", embeddingConfig());

    await expect(result).rejects.toBeInstanceOf(Error);
    await expect(result).rejects.toThrow("fallback unavailable");
    if (typeof failure === "object") {
      await expect(result).rejects.toMatchObject({ ...failure, cause: failure });
    }
    expect(openAiMocks.calls.map((c) => c.baseURL)).toEqual([PRIMARY, FALLBACK]);
  });
});
