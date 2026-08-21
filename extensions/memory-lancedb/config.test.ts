// Memory Lancedb tests cover config plugin behavior.
import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { memoryConfigSchema } from "./config.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
) as { configSchema: JsonSchemaObject; uiHints?: Record<string, unknown> };

describe("memory-lancedb config", () => {
  it("keeps config presentation metadata manifest-owned", () => {
    expect(memoryConfigSchema).not.toHaveProperty("uiHints");
    expect(manifest.uiHints?.["embedding.apiKey"]).toMatchObject({
      label: "Embedding API Key",
      sensitive: true,
    });
  });

  it("accepts dreaming in the manifest schema and preserves it in runtime parsing", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.dreaming",
      value: {
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
      },
      dreaming: {
        enabled: true,
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.dreaming).toEqual({
      enabled: true,
    });
  });

  it("accepts provider-backed embedding config without a plugin apiKey", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.provider-auth",
      value: {
        embedding: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.embedding.apiKey).toBeUndefined();
    expect(parsed.embedding.provider).toBe("openai");
  });

  it("rejects empty embedding config in the manifest schema and runtime parser", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.empty-embedding",
      value: {
        embedding: {},
      },
    });

    expect(manifestResult.ok).toBe(false);
    if (!manifestResult.ok) {
      expect(manifestResult.errors.map((error) => error.text)).toContain(
        "embedding: must not have fewer than 1 properties",
      );
    }

    expect(() => {
      memoryConfigSchema.parse({
        embedding: {},
      });
    }).toThrow("embedding config must include at least one setting");
  });

  it("allows missing embedding config in the manifest so setup can discover fields", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.missing-embedding",
      value: {},
    });

    expect(manifestResult.ok).toBe(true);
    expect(() => {
      memoryConfigSchema.parse({});
    }).toThrow("embedding config required");
  });

  it("rejects empty embedding providers", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          provider: "",
          model: "text-embedding-3-small",
        },
      });
    }).toThrow("embedding.provider must not be empty");
  });

  it("defaults non-finite character budgets and rejects invalid dimensions", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.invalid-dimensions",
      value: {
        embedding: {
          apiKey: "sk-test",
          dimensions: 1024.5,
        },
      },
    });
    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
      },
      captureMaxChars: Number.NaN,
      recallMaxChars: Number.POSITIVE_INFINITY,
    });

    expect(parsed.captureMaxChars).toBe(500);
    expect(parsed.recallMaxChars).toBe(1000);
    expect(manifestResult.ok).toBe(false);
    for (const dimensions of [Number.NaN, 1024.5]) {
      expect(() => {
        memoryConfigSchema.parse({
          embedding: {
            apiKey: "sk-test",
            dimensions,
          },
        });
      }).toThrow("embedding.dimensions must be a positive integer");
    }
  });

  it("still rejects unrelated unknown top-level config keys", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: {
          enabled: true,
        },
        unexpected: true,
      });
    }).toThrow("memory config has unknown keys: unexpected");
  });

  it("accepts custom trigger literals in the manifest schema and runtime parser", () => {
    const manifestResult = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.custom-triggers",
      value: {
        embedding: {
          apiKey: "sk-test",
        },
        customTriggers: ["记住", "important project"],
      },
    });

    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
      },
      customTriggers: ["  记住  ", "important project"],
    });

    expect(manifestResult.ok).toBe(true);
    expect(parsed.customTriggers).toEqual(["记住", "important project"]);
  });

  it("rejects unsafe custom trigger config values", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        customTriggers: ["记住", ""],
      });
    }).toThrow("customTriggers.1 must not be empty");

    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        customTriggers: ["x".repeat(101)],
      });
    }).toThrow("customTriggers.0 must be at most 100 characters");
  });

  it("rejects non-object dreaming values in runtime parsing", () => {
    expect(() => {
      memoryConfigSchema.parse({
        embedding: {
          apiKey: "sk-test",
        },
        dreaming: true,
      });
    }).toThrow("dreaming config must be an object");
  });

  it("accepts valid embedding timeoutMs and maxRetries in runtime parsing and the manifest schema", () => {
    const parsed = memoryConfigSchema.parse({
      embedding: {
        apiKey: "sk-test",
        timeoutMs: 15_000,
        maxRetries: 3,
      },
    });
    expect(parsed.embedding.timeoutMs).toBe(15_000);
    expect(parsed.embedding.maxRetries).toBe(3);

    const result = validateJsonSchemaValue({
      schema: manifest.configSchema,
      cacheKey: "memory-lancedb.manifest.timeout-retries",
      value: {
        embedding: {
          apiKey: "sk-test",
          timeoutMs: 10_000,
          maxRetries: 2,
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts boundary values for embedding timeoutMs and maxRetries", () => {
    const low = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 1000, maxRetries: 0 },
    });
    expect(low.embedding.timeoutMs).toBe(1000);
    expect(low.embedding.maxRetries).toBe(0);

    const high = memoryConfigSchema.parse({
      embedding: { apiKey: "sk-test", timeoutMs: 60_000, maxRetries: 5 },
    });
    expect(high.embedding.timeoutMs).toBe(60_000);
    expect(high.embedding.maxRetries).toBe(5);
  });

  it("falls back to undefined for out-of-bounds or non-finite timeoutMs", () => {
    for (const timeoutMs of [500, 120_000, Number.NaN, Infinity, -1000, "10000", null]) {
      const parsed = memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test", timeoutMs: timeoutMs as number },
      });
      expect(parsed.embedding.timeoutMs).toBeUndefined();
    }
  });

  it("falls back to undefined for out-of-bounds, non-integer, or non-finite maxRetries", () => {
    for (const maxRetries of [-1, 10, 2.5, Number.NaN, Infinity, "3", null]) {
      const parsed = memoryConfigSchema.parse({
        embedding: { apiKey: "sk-test", maxRetries: maxRetries as number },
      });
      expect(parsed.embedding.maxRetries).toBeUndefined();
    }
  });

  it("rejects out-of-range embedding timeoutMs and maxRetries in the manifest schema", () => {
    expect(
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        cacheKey: "memory-lancedb.manifest.timeout-oob",
        value: {
          embedding: { apiKey: "sk-test", timeoutMs: 500 },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        cacheKey: "memory-lancedb.manifest.retries-oob",
        value: {
          embedding: { apiKey: "sk-test", maxRetries: 10 },
        },
      }).ok,
    ).toBe(false);
  });

  it("keeps embedding timeoutMs and maxRetries manifest-owned in uiHints", () => {
    expect(manifest.uiHints?.["embedding.timeoutMs"]).toMatchObject({
      label: "Timeout (ms)",
      advanced: true,
    });
    expect(manifest.uiHints?.["embedding.maxRetries"]).toMatchObject({
      label: "Max Retries",
      advanced: true,
    });
    expect(memoryConfigSchema).not.toHaveProperty("uiHints");
  });
});
