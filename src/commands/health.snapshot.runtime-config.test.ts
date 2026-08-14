// Runtime-config drift health tests exercise the builder directly against a
// config.js mock while keeping the main health snapshot suite under max-lines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDiskSourceConfig: Record<string, unknown> | null = null;
let testDiskSnapshotExists: boolean | null = null;
let testDiskSnapshotValid: boolean | null = null;
let testRuntimeSourceConfig: Record<string, unknown> | null = null;
let testRuntimeConfigSnapshotMetadata: {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
} | null = null;

let buildRuntimeConfigHealth: typeof import("./health-runtime-config.js").buildRuntimeConfigHealth;

async function loadFreshHealthDriftModule() {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfigSourceSnapshot: () => testRuntimeSourceConfig,
    getRuntimeConfigSnapshotMetadata: () => testRuntimeConfigSnapshotMetadata,
    readSourceConfigSnapshot: async () => {
      if (testDiskSnapshotExists === false) {
        return {
          path: "/tmp/openclaw.json",
          exists: false,
          raw: null,
          parsed: null,
          sourceConfig: {} as Record<string, unknown>,
          resolved: {} as Record<string, unknown>,
          valid: true,
          runtimeConfig: {} as Record<string, unknown>,
          config: {} as Record<string, unknown>,
          issues: [],
          warnings: [],
          legacyIssues: [],
        };
      }
      if (testDiskSnapshotValid === false) {
        return {
          path: "/tmp/openclaw.json",
          exists: true,
          raw: "{invalid",
          parsed: null,
          sourceConfig: {} as Record<string, unknown>,
          resolved: {} as Record<string, unknown>,
          valid: false,
          runtimeConfig: {} as Record<string, unknown>,
          config: {} as Record<string, unknown>,
          issues: [
            { path: "", message: "JSON5 parse error: unexpected token", code: "PARSE_ERROR" },
          ],
          warnings: [],
          legacyIssues: [],
        };
      }
      const source = testDiskSourceConfig ?? testRuntimeSourceConfig ?? {};
      return {
        path: "/tmp/openclaw.json",
        exists: true,
        raw: JSON.stringify(source),
        parsed: source,
        sourceConfig: source,
        resolved: source,
        valid: true,
        runtimeConfig: source,
        config: source,
        issues: [],
        warnings: [],
        legacyIssues: [],
      };
    },
  }));
  vi.resetModules();
  ({ buildRuntimeConfigHealth } = await import("./health-runtime-config.js"));
}

describe("buildRuntimeConfigHealth drift", () => {
  beforeEach(async () => {
    testDiskSourceConfig = null;
    testDiskSnapshotExists = null;
    testDiskSnapshotValid = null;
    testRuntimeSourceConfig = null;
    testRuntimeConfigSnapshotMetadata = null;
    vi.resetModules();
    vi.doUnmock("../config/config.js");
    await loadFreshHealthDriftModule();
  });

  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.resetModules();
  });

  it("surfaces model/provider runtime config drift between live gateway and disk", async () => {
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai-codex/gpt-5.5" } },
    };
    testDiskSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 7,
      fingerprint: "runtime-fingerprint",
      sourceFingerprint: "live-source-fingerprint",
      updatedAtMs: 123,
    };

    const runtimeConfig = await buildRuntimeConfigHealth();

    expect(runtimeConfig).toEqual({
      state: "drift",
      liveDefaultModel: "openai-codex/gpt-5.5",
      diskDefaultModel: "openai/gpt-5.5",
      driftPaths: ["agents.defaults.model"],
      message:
        "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
    });
  });

  it("detects drift on top-level auth.profiles when provider-auth rotates on disk", async () => {
    // Provider-auth repairs touch `auth.profiles` (named provider profile
    // config) rather than the gateway access auth under `gateway.auth.*`.
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      auth: { profiles: { primary: { provider: "openai", mode: "token" } } },
    };
    testDiskSourceConfig = {
      session: { store: "/tmp/x" },
      auth: { profiles: { primary: { provider: "openai", mode: "chatgpt" } } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 8,
      fingerprint: "runtime-fingerprint-auth",
      sourceFingerprint: "live-source-fingerprint-auth",
      updatedAtMs: 234,
    };

    const runtimeConfig = await buildRuntimeConfigHealth();

    expect(runtimeConfig?.state).toBe("drift");
    expect(runtimeConfig?.driftPaths).toEqual(["auth.profiles"]);
  });

  it("reports a redacted unknown state when the disk config file is missing", async () => {
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 9,
      fingerprint: "runtime-fingerprint-missing",
      sourceFingerprint: "live-source-fingerprint-missing",
      updatedAtMs: 345,
    };
    testDiskSnapshotExists = false;

    const runtimeConfig = await buildRuntimeConfigHealth();

    expect(runtimeConfig?.state).toBe("unknown");
    expect(runtimeConfig?.driftPaths).toBeUndefined();
    expect(runtimeConfig?.message).toBe("Disk config source snapshot is unavailable.");
  });

  it("reports a redacted unknown state when the disk config is invalid", async () => {
    testRuntimeSourceConfig = {
      session: { store: "/tmp/x" },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    testRuntimeConfigSnapshotMetadata = {
      revision: 10,
      fingerprint: "runtime-fingerprint-invalid",
      sourceFingerprint: "live-source-fingerprint-invalid",
      updatedAtMs: 456,
    };
    testDiskSnapshotValid = false;

    const runtimeConfig = await buildRuntimeConfigHealth();

    expect(runtimeConfig?.state).toBe("unknown");
    expect(runtimeConfig?.driftPaths).toBeUndefined();
    expect(runtimeConfig?.message).toBe("Disk config source snapshot is unavailable.");
    expect(JSON.stringify(runtimeConfig)).not.toContain("/tmp/openclaw.json");
    expect(JSON.stringify(runtimeConfig)).not.toContain("unexpected token");
  });
});
