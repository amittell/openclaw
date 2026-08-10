import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildRuntimeConfigHealthSummary,
  readRuntimeHealthConfigState,
  type RuntimeHealthConfigState,
} from "./runtime-config.js";

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getRuntimeConfigSnapshotMetadata: vi.fn(),
  getRuntimeConfigSourceSnapshot: vi.fn(),
  hashRuntimeConfigValue: vi.fn(),
  readSourceConfigSnapshot: vi.fn(),
}));

vi.mock("../../config/config.js", () => configMocks);

const liveConfig = {
  agents: { defaults: { model: "openai-codex/gpt-5.5" } },
} satisfies OpenClawConfig;
const diskConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
} satisfies OpenClawConfig;

function createState(overrides: Partial<RuntimeHealthConfigState> = {}): RuntimeHealthConfigState {
  return {
    config: liveConfig,
    sourceConfig: liveConfig,
    metadata: {
      revision: 7,
      fingerprint: "runtime-fingerprint",
      sourceFingerprint: "live-source-fingerprint",
      updatedAtMs: 123,
    },
    diskSourceConfig: diskConfig,
    hashConfigValue: (config) => (config === diskConfig ? "disk-fingerprint" : "live-hash"),
    ...overrides,
  };
}

describe("runtime config health", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports model/provider drift with fingerprints for admin snapshots", () => {
    expect(buildRuntimeConfigHealthSummary(createState(), { includeFingerprints: true })).toEqual({
      state: "drift",
      liveSourceFingerprint: "live-source-fingerprint",
      diskSourceFingerprint: "disk-fingerprint",
      liveDefaultModel: "openai-codex/gpt-5.5",
      diskDefaultModel: "openai/gpt-5.5",
      driftPaths: ["agents.defaults.model"],
      message:
        "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
    });
  });

  it("omits fingerprints from non-admin drift snapshots", () => {
    const summary = buildRuntimeConfigHealthSummary(createState());

    expect(summary).toMatchObject({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
      liveDefaultModel: "openai-codex/gpt-5.5",
      diskDefaultModel: "openai/gpt-5.5",
    });
    expect(summary).not.toHaveProperty("liveSourceFingerprint");
    expect(summary).not.toHaveProperty("diskSourceFingerprint");
  });

  it("detects provider-auth profile drift", () => {
    const liveAuth = {
      auth: { profiles: { primary: { provider: "openai", mode: "token" } } },
    } satisfies OpenClawConfig;
    const diskAuth = {
      auth: { profiles: { primary: { provider: "openai", mode: "oauth" } } },
    } satisfies OpenClawConfig;

    expect(
      buildRuntimeConfigHealthSummary(
        createState({ sourceConfig: liveAuth, diskSourceConfig: diskAuth }),
      )?.driftPaths,
    ).toEqual(["auth.profiles"]);
  });

  it("redacts disk-read details and fingerprints outside the admin boundary", () => {
    const state = createState({
      diskSourceConfig: null,
      diskReadError: "Disk config is invalid: secret local parse detail",
    });

    expect(buildRuntimeConfigHealthSummary(state)).toEqual({
      state: "unknown",
      liveDefaultModel: "openai-codex/gpt-5.5",
      message: "Disk config source snapshot is unavailable.",
    });
    expect(buildRuntimeConfigHealthSummary(state, { includeFingerprints: true })).toEqual({
      state: "unknown",
      liveSourceFingerprint: "live-source-fingerprint",
      liveDefaultModel: "openai-codex/gpt-5.5",
      message:
        "Could not read disk config source snapshot: Disk config is invalid: secret local parse detail",
    });
  });

  it.each([
    {
      name: "missing",
      snapshot: { exists: false, path: "/tmp/openclaw.json", valid: true, issues: [] },
      expected: /not found/i,
    },
    {
      name: "invalid",
      snapshot: {
        exists: true,
        path: "/tmp/openclaw.json",
        valid: false,
        issues: [{ message: "unexpected token" }],
      },
      expected: /invalid: unexpected token/i,
    },
  ])("reads $name disk config as an unknown health state", async ({ snapshot, expected }) => {
    configMocks.getRuntimeConfig.mockReturnValue(liveConfig);
    configMocks.getRuntimeConfigSourceSnapshot.mockReturnValue(liveConfig);
    configMocks.getRuntimeConfigSnapshotMetadata.mockReturnValue(null);
    configMocks.hashRuntimeConfigValue.mockReturnValue("live-hash");
    configMocks.readSourceConfigSnapshot.mockResolvedValue(snapshot);

    const state = await readRuntimeHealthConfigState();
    const summary = buildRuntimeConfigHealthSummary(state, { includeFingerprints: true });

    expect(summary?.state).toBe("unknown");
    expect(summary?.driftPaths).toBeUndefined();
    expect(summary?.message).toMatch(expected);
  });
});
