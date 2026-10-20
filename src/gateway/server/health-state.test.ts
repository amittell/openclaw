// Health-state tests cover probe coalescing, sensitive snapshots, and broadcast version behavior.
import "../../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import type { ConfigReloadObservation } from "../config-reload-observed.js";
import type { HealthSummary } from "../health/types.js";
import type { GatewayEventLoopHealth } from "./event-loop-health.js";

/**
 * Health-state cache tests covering coalescing, sensitive probes, and broadcasts.
 */
const {
  buildRuntimeConfigHealthMock,
  collectGatewayHealthSnapshotMock,
  getConfigReloadObservationMock,
  getRuntimeConfigSourceSnapshotMock,
  getRuntimeConfigSnapshotMetadataMock,
  getRuntimeConfigMock,
  getUpdateAvailableMock,
  getUpdateScheduleMock,
} = vi.hoisted(() => ({
  buildRuntimeConfigHealthMock: vi.fn(),
  collectGatewayHealthSnapshotMock: vi.fn(),
  getConfigReloadObservationMock: vi.fn((): ConfigReloadObservation => ({
    generation: 0,
    sourceConfig: null,
  })),
  getRuntimeConfigSourceSnapshotMock: vi.fn((): OpenClawConfig | null => null),
  getRuntimeConfigSnapshotMetadataMock: vi.fn<() => { revision: number } | null>(() => ({
    revision: 0,
  })),
  getRuntimeConfigMock: vi.fn(),
  getUpdateAvailableMock: vi.fn(),
  getUpdateScheduleMock: vi.fn(),
}));

vi.mock("../../commands/health-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/health-runtime-config.js")>()),
  buildRuntimeConfigHealth: buildRuntimeConfigHealthMock,
}));

vi.mock("../config-reload-observed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-reload-observed.js")>()),
  getConfigReloadObservation: getConfigReloadObservationMock,
}));

vi.mock("../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/runtime-snapshot.js")>()),
  getRuntimeConfigAppliedHash: () => "internal-applied-hash",
  getRuntimeConfigSourceSnapshot: getRuntimeConfigSourceSnapshotMock,
  getRuntimeConfigSnapshotMetadata: getRuntimeConfigSnapshotMetadataMock,
}));

vi.mock("../health/collector.js", () => ({
  collectGatewayHealthSnapshot: collectGatewayHealthSnapshotMock,
}));

vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../../infra/update-status-state.js", () => ({
  getUpdateAvailable: getUpdateAvailableMock,
  getUpdateSchedule: getUpdateScheduleMock,
}));

function healthSnapshotCallArg(index = 0) {
  return collectGatewayHealthSnapshotMock.mock.calls.at(index)?.at(0) as
    | {
        audience?: "public" | "admin";
        eventLoop?: unknown;
        probe?: boolean;
        runtimeSnapshot?: unknown;
        configReloadHotReloadStatus?: unknown;
      }
    | undefined;
}

// Vitest manual mocks cannot resolve concurrent imports from one module. Enter
// each collector separately while keeping its result pending to test overlap.
function createPendingHealthSnapshot() {
  const started = createDeferred();
  const result = createDeferred<HealthSummary>();
  return {
    ...result,
    started: started.promise,
    collect: () => {
      started.resolve();
      return result.promise;
    },
  };
}

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      recent: [],
    },
  };
}

const revisionProjector = {
  projectRawHash: (hash: string) => `raw-token:${hash}`,
  projectResolvedHash: (hash: string) => `resolved-token:${hash}`,
  hashResponseSessionBearer: () => "unused-test-scope",
};

async function loadHealthState() {
  vi.resetModules();
  collectGatewayHealthSnapshotMock.mockReset();
  collectGatewayHealthSnapshotMock.mockResolvedValue(createHealthSummary());
  buildRuntimeConfigHealthMock.mockReset();
  buildRuntimeConfigHealthMock.mockReturnValue(undefined);
  getConfigReloadObservationMock.mockReset();
  getConfigReloadObservationMock.mockReturnValue({ generation: 0, sourceConfig: null });
  getRuntimeConfigSourceSnapshotMock.mockReset();
  getRuntimeConfigSourceSnapshotMock.mockReturnValue(null);
  getRuntimeConfigSnapshotMetadataMock.mockReset();
  getRuntimeConfigSnapshotMetadataMock.mockReturnValue({ revision: 0 });
  getUpdateAvailableMock.mockReset();
  getUpdateAvailableMock.mockReturnValue(null);
  getUpdateScheduleMock.mockReset();
  getUpdateScheduleMock.mockReturnValue(null);
  getRuntimeConfigMock.mockReset().mockReturnValue({ agents: { entries: { main: {} } } });
  return await import("./health-state.js");
}

describe("buildGatewaySnapshot update metadata", () => {
  it("presents the pinned config and state paths together after runtime selection", async () => {
    const healthState = await loadHealthState();
    const paths = await import("../../config/paths.js");
    const original = { configPath: paths.CONFIG_PATH, stateDir: paths.STATE_DIR };
    try {
      for (const selection of ["first", "second"]) {
        const stateDir = path.join(original.stateDir, selection);
        const configPath = path.join(stateDir, "gateway.json");
        paths.pinRuntimePaths({
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
        });
        const snapshot = healthState.buildGatewaySnapshot({
          client: null,
          includeSensitive: true,
          revisionProjector,
        });
        expect(snapshot).toMatchObject({ configPath, stateDir });
        expect(
          healthState.buildGatewaySnapshot({ client: null, revisionProjector }),
        ).not.toHaveProperty("configPath");
      }
    } finally {
      paths.pinRuntimePaths({
        ...process.env,
        OPENCLAW_CONFIG_PATH: original.configPath,
        OPENCLAW_STATE_DIR: original.stateDir,
      });
    }
  });

  it("reads suspension synchronously without waiting for health collection", async () => {
    const healthState = await loadHealthState();
    resetGatewayWorkAdmission();
    const read = () =>
      healthState.buildGatewaySnapshot({ client: null, revisionProjector }).suspension;
    try {
      expect(read()).toEqual({ phase: "accepting" });
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(read()).toEqual({ phase: "preparing" });
      suspension?.drain();
      expect(read()).toEqual({ phase: "draining" });
      suspension?.commit();
      expect(read()).toEqual({ phase: "prepared" });
      suspension?.release();
      expect(read()).toEqual({ phase: "accepting" });
      expect(collectGatewayHealthSnapshotMock).not.toHaveBeenCalled();
    } finally {
      resetGatewayWorkAdmission();
    }
  });

  it("omits the schedule and projects legacy availability without update detail access", async () => {
    const healthState = await loadHealthState();
    getUpdateAvailableMock.mockReturnValue({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    });
    getUpdateScheduleMock.mockReturnValue({
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" },
    });

    const snapshot = healthState.buildGatewaySnapshot({
      client: null,
      includeUpdateDetails: false,
      revisionProjector,
    });

    expect(snapshot.updateAvailable).toEqual({
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
    });
    expect(snapshot.updateSchedule).toBeUndefined();
    expect(snapshot.sessionDefaults).toMatchObject({ ownership: "sole", selectionRequired: false });
    expect(snapshot.appliedConfigHash).toBe("resolved-token:internal-applied-hash");
    expect(getUpdateScheduleMock).not.toHaveBeenCalled();
  });

  it("includes the full update availability and schedule with update detail access", async () => {
    const healthState = await loadHealthState();
    const updateAvailable = {
      currentVersion: "2026.8.7",
      latestVersion: "2026.8.8",
      channel: "dev",
      currentSha: "1111111111111111111111111111111111111111",
      upstreamRef: "origin/main",
      upstreamSha: "2222222222222222222222222222222222222222",
      commitsBehind: 1,
      commits: [{ sha: "2222222", subject: "Detailed commit subject" }],
    };
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" as const },
    };
    getUpdateAvailableMock.mockReturnValue(updateAvailable);
    getUpdateScheduleMock.mockReturnValue(updateSchedule);

    const snapshot = healthState.buildGatewaySnapshot({
      client: null,
      includeUpdateDetails: true,
      revisionProjector,
    });

    expect(snapshot.updateAvailable).toBe(updateAvailable);
    expect(snapshot.updateSchedule).toBe(updateSchedule);
  });
});

describe("refreshGatewayHealthSnapshot", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes one redacted runtime-config diagnostic to cache and broadcasts", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    buildRuntimeConfigHealthMock.mockReturnValue({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
    });
    healthState.setBroadcastHealthUpdate(broadcast);

    const published = await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledOnce();
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledWith({
      liveSourceConfig: null,
      hasLiveSnapshot: true,
      observedSourceConfig: null,
    });
    expect(published.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
    });
    expect(healthState.getHealthCache()).toBe(published);
    expect(broadcast).toHaveBeenCalledWith(published);
    expect(JSON.stringify(published)).not.toContain("Fingerprint");
  });

  it("projects current config for hello while RPC and broadcast await full recollection", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    const firstSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
    const latestSourceConfig = { agents: { defaults: { model: "openai/gpt-5.6-terra" } } };
    let observation = { generation: 7, sourceConfig: firstSourceConfig };
    collectGatewayHealthSnapshotMock
      .mockResolvedValueOnce(createHealthSummary())
      .mockResolvedValueOnce(createHealthSummary());
    getRuntimeConfigSourceSnapshotMock.mockReturnValue(firstSourceConfig);
    getConfigReloadObservationMock.mockImplementation(() => observation);
    buildRuntimeConfigHealthMock
      .mockReturnValueOnce({ state: "ok" })
      .mockReturnValueOnce({ state: "drift", driftPaths: ["agents.defaults.model"] })
      .mockReturnValueOnce({ state: "drift", driftPaths: ["agents.defaults.model"] });
    healthState.setBroadcastHealthUpdate(broadcast);

    const first = await healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(first.runtimeConfig).toEqual({ state: "ok" });
    expect(healthState.getHealthCache()).toBe(first);
    const firstVersion = healthState.getHealthVersion();

    observation = { generation: 8, sourceConfig: latestSourceConfig };
    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.readCurrentRuntimeConfigHealth()).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
    });
    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(firstVersion);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledOnce();
    expect(broadcast.mock.calls.map(([snapshot]) => snapshot.runtimeConfig)).toEqual([
      { state: "ok" },
    ]);

    const current = await healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(current.runtimeConfig).toEqual({
      state: "drift",
      driftPaths: ["agents.defaults.model"],
    });
    expect(healthState.getHealthCache()).toBe(current);
    expect(healthState.getHealthVersion()).toBe(firstVersion + 1);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledTimes(3);
    expect(buildRuntimeConfigHealthMock).toHaveBeenLastCalledWith({
      liveSourceConfig: firstSourceConfig,
      hasLiveSnapshot: true,
      observedSourceConfig: latestSourceConfig,
    });
    expect(broadcast.mock.calls.map(([snapshot]) => snapshot.runtimeConfig)).toEqual([
      { state: "ok" },
      { state: "drift", driftPaths: ["agents.defaults.model"] },
    ]);
  });

  it("recollects the whole snapshot when the runtime revision advances", async () => {
    const healthState = await loadHealthState();
    const firstCollection = createDeferred<HealthSummary>();
    const staleSummary = createHealthSummary();
    const currentSummary = createHealthSummary();
    const staleRuntime = { channels: {}, channelAccounts: { stale: {} } };
    const currentRuntime = { channels: {}, channelAccounts: { current: {} } };
    let publication = { revision: 21 };
    getRuntimeConfigSnapshotMetadataMock.mockImplementation(() => publication);
    // Advance the revision once collection has started: refresh first awaits the
    // lazy collector import, so a synchronous bump would precede the first read.
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(() => {
        publication = { revision: publication.revision + 1 };
        return firstCollection.promise;
      })
      .mockResolvedValueOnce(currentSummary);
    const getRuntimeSnapshot = vi
      .fn()
      .mockReturnValueOnce(staleRuntime)
      .mockReturnValueOnce(currentRuntime);

    const refresh = healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot,
    });
    firstCollection.resolve(staleSummary);

    await expect(refresh).resolves.toBe(currentSummary);
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(staleRuntime);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBe(currentRuntime);
    expect(buildRuntimeConfigHealthMock).toHaveBeenCalledOnce();
    expect(healthState.getHealthCache()).toBe(currentSummary);
  });

  it.each(["cached", "pending"] as const)(
    "rejects %s health after runtime reset reuses a revision",
    async (phase) => {
      const healthState = await loadHealthState();
      const runtime = await vi.importActual<typeof import("../../config/runtime-snapshot.js")>(
        "../../config/runtime-snapshot.js",
      );
      const { buildRuntimeConfigHealth } = await vi.importActual<
        typeof import("../../commands/health-runtime-config.js")
      >("../../commands/health-runtime-config.js");
      runtime.clearRuntimeConfigSnapshot();
      const pending = createPendingHealthSnapshot();
      const staleSummary = createHealthSummary();
      const pendingRefresh: { promise?: Promise<HealthSummary> } = {};
      onTestFinished(async () => {
        pending.resolve(staleSummary);
        try {
          await pendingRefresh.promise?.catch(() => {});
        } finally {
          runtime.clearRuntimeConfigSnapshot();
        }
      });
      const firstConfig = { agents: { defaults: { model: "provider/first" } } };
      const currentConfig = { agents: { defaults: { model: "provider/current" } } };
      runtime.setRuntimeConfigSnapshot(firstConfig, firstConfig);
      const firstPublication = runtime.getRuntimeConfigSnapshotMetadata();
      expect(firstPublication?.revision).toBe(1);
      getRuntimeConfigSnapshotMetadataMock.mockImplementation(
        runtime.getRuntimeConfigSnapshotMetadata,
      );
      getRuntimeConfigSourceSnapshotMock.mockImplementation(runtime.getRuntimeConfigSourceSnapshot);
      getConfigReloadObservationMock.mockReturnValue({ generation: 7, sourceConfig: firstConfig });
      buildRuntimeConfigHealthMock.mockImplementation(buildRuntimeConfigHealth);
      const currentSummary = { ...createHealthSummary(), ts: staleSummary.ts + 1 };
      const broadcast = vi.fn();
      healthState.setBroadcastHealthUpdate(broadcast);
      collectGatewayHealthSnapshotMock
        .mockImplementationOnce(phase === "cached" ? async () => staleSummary : pending.collect)
        .mockResolvedValueOnce(currentSummary);
      const refresh = healthState.refreshGatewayHealthSnapshot({ probe: false });
      pendingRefresh.promise = refresh;
      if (phase === "cached") {
        await expect(refresh).resolves.toBe(staleSummary);
        expect(healthState.getHealthCache()).toBe(staleSummary);
      } else {
        await pending.started;
      }

      runtime.clearRuntimeConfigSnapshot();
      runtime.setRuntimeConfigSnapshot(currentConfig, currentConfig);
      const currentPublication = runtime.getRuntimeConfigSnapshotMetadata();
      expect(currentPublication?.revision).toBe(firstPublication?.revision);
      expect(currentPublication).not.toBe(firstPublication);
      if (phase === "cached") {
        expect(healthState.getHealthCache()).toBeNull();
      }
      pending.resolve(staleSummary);
      const current =
        phase === "cached"
          ? await healthState.refreshGatewayHealthSnapshot({ probe: false })
          : await refresh;

      expect(current).toBe(currentSummary);
      expect(current.runtimeConfig).toMatchObject({
        state: "drift",
        driftPaths: ["agents.defaults.model"],
      });
      expect(healthState.getHealthCache()).toBe(currentSummary);
      expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
      expect(broadcast.mock.calls.map(([snapshot]) => snapshot)).toEqual(
        phase === "cached" ? [staleSummary, currentSummary] : [currentSummary],
      );
    },
  );

  it("broadcasts config health only while its observation is current", async () => {
    const healthState = await loadHealthState();
    const { buildRuntimeConfigHealth } = await vi.importActual<
      typeof import("../../commands/health-runtime-config.js")
    >("../../commands/health-runtime-config.js");
    const liveSourceConfig = { agents: { defaults: { model: "provider/live" } } };
    const changedSourceConfig = { agents: { defaults: { model: "provider/changed" } } };
    let observation = { generation: 7, sourceConfig: liveSourceConfig };
    getRuntimeConfigSourceSnapshotMock.mockReturnValue(liveSourceConfig);
    getConfigReloadObservationMock.mockImplementation(() => observation);
    let queuedObservation = false;
    buildRuntimeConfigHealthMock.mockImplementation((params) => {
      if (!queuedObservation) {
        queuedObservation = true;
        queueMicrotask(() => {
          observation = { generation: 8, sourceConfig: changedSourceConfig };
        });
      }
      return buildRuntimeConfigHealth(params);
    });
    const publications: Array<{ state: string | undefined; generation: number }> = [];
    healthState.setBroadcastHealthUpdate((snapshot) => {
      publications.push({
        state: snapshot.runtimeConfig?.state,
        generation: observation.generation,
      });
    });

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(publications).toEqual([{ state: "ok", generation: 7 }]);
    expect(healthState.getHealthCache()).toBeNull();
    await healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(publications).toEqual([
      { state: "ok", generation: 7 },
      { state: "drift", generation: 8 },
    ]);
  });

  it("refreshes the config cache key without broadcasting equivalent health", async () => {
    const healthState = await loadHealthState();
    let observation = { generation: 7, sourceConfig: null };
    getConfigReloadObservationMock.mockImplementation(() => observation);
    buildRuntimeConfigHealthMock.mockReturnValue({ state: "ok" });
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const first = await healthState.refreshGatewayHealthSnapshot({ probe: false });
    const version = healthState.getHealthVersion();
    observation = { generation: 8, sourceConfig: null };
    expect(healthState.getHealthCache()).toBeNull();
    const next = { ...createHealthSummary(), ts: first.ts + 1 };
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(next);

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(healthState.getHealthCache()).toBe(next);
    expect(healthState.getHealthVersion()).toBe(version);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it("refreshes diagnostics without rebroadcasting clock and activity changes", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();
    const snapshot = (time: number): HealthSummary => ({
      ...createHealthSummary(),
      ts: time,
      durationMs: time,
      eventLoop: {
        degraded: false,
        degradedSinceMs: null,
        reasons: [],
        intervalMs: time,
        delayP99Ms: time,
        delayMaxMs: time,
        utilization: time / 1000,
        cpuCoreRatio: time / 1000,
      },
      channels: {
        example: {
          accountId: "default",
          connected: true,
          busy: time % 2 === 0,
          activeRuns: time,
          activeRunStartedAt: time,
          accounts: {
            default: {
              accountId: "default",
              connected: true,
              busy: time % 2 === 0,
              activeRuns: time,
              activeRunStartedAt: time,
              authAgeMs: time,
              lastProbeAt: time,
              lastInboundAt: time,
              lastOutboundAt: time,
              lastTransportActivityAt: time,
              lastEventAt: time,
              lastMessageAt: time,
              lastRunActivityAt: time,
            },
          },
        },
      },
      sessions: {
        path: "/synthetic/sessions",
        count: time,
        recent: [{ key: `agent:main:session-${time}`, age: time, updatedAt: time }],
      },
      agents: [
        {
          agentId: "main",
          isDefault: true,
          heartbeat: {
            enabled: false,
            every: "0m",
            everyMs: null,
            prompt: "",
            target: "none",
            ackMaxChars: 0,
          },
          sessions: {
            path: "/synthetic/sessions",
            count: time,
            recent: [{ key: `agent:main:session-${time}`, age: time, updatedAt: time }],
          },
        },
      ],
    });
    const first = snapshot(1);
    const next = snapshot(2);
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(first).mockResolvedValueOnce(next);
    await healthState.refreshGatewayHealthSnapshot({ probe: false });
    await expect(healthState.refreshGatewayHealthSnapshot({ probe: false })).resolves.toBe(next);
    expect(healthState.getHealthCache()).toBe(next);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(first);
    expect(healthState.getHealthVersion()).toBe(version + 1);

    // An explicit check still returns fresh diagnostic readings, without an unchanged event.
    const probe = snapshot(3);
    collectGatewayHealthSnapshotMock.mockResolvedValueOnce(probe);
    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(probe);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("publishes channel failures, recovery, and other material changes on the next refresh", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const initial = createHealthSummary();
    const eventLoop = {
      degraded: false,
      reasons: [],
      intervalMs: 1_000,
      delayP99Ms: 10,
      delayMaxMs: 20,
      utilization: 0.1,
      cpuCoreRatio: 0.1,
    } satisfies HealthSummary["eventLoop"];
    const disconnected = {
      ...initial,
      channels: {
        example: {
          accountId: "default",
          accounts: {
            secondary: { accountId: "secondary", connected: false, lastError: "offline" },
          },
        },
      },
    };
    const snapshots: HealthSummary[] = [
      initial,
      disconnected,
      initial,
      {
        ...initial,
        plugins: {
          loaded: [],
          errors: [{ id: "provider", origin: "bundled", activated: true, error: "unavailable" }],
        },
      },
      { ...initial, configReload: { hotReloadStatus: "disabled" } },
      { ...initial, eventLoop },
      {
        ...initial,
        eventLoop: {
          ...eventLoop,
          degraded: true,
          degradedSinceMs: 60_000,
          reasons: ["event_loop_delay"],
        },
      },
      { ...initial, eventLoop },
      {
        ...initial,
        channels: { example: { accountId: "default", lastStartAt: 1, lastStopAt: 2 } },
      },
      {
        ...initial,
        channels: { example: { accountId: "default", lastStartAt: 3, lastStopAt: 2 } },
      },
    ];
    for (const summary of snapshots) {
      collectGatewayHealthSnapshotMock.mockResolvedValueOnce(summary);
      await healthState.refreshGatewayHealthSnapshot({ probe: false });
    }
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual(snapshots);
  });

  it("publishes sustained event-loop degradation without broadcasting transient sample flaps", async () => {
    const healthState = await loadHealthState();
    const broadcast = vi.fn();
    healthState.setBroadcastHealthUpdate(broadcast);
    const snapshot = (degradedSinceMs: number | null): HealthSummary => ({
      ...createHealthSummary(),
      eventLoop: {
        degraded: degradedSinceMs !== null,
        degradedSinceMs,
        reasons: degradedSinceMs === null ? [] : ["event_loop_delay"],
        intervalMs: 1_000,
        delayP99Ms: degradedSinceMs === null ? 10 : 1_500,
        delayMaxMs: degradedSinceMs === null ? 20 : 1_700,
        utilization: 0.2,
        cpuCoreRatio: 0.1,
      },
    });
    const healthy = snapshot(null);
    const sustained = snapshot(60_000);
    const recovered = snapshot(null);
    for (const summary of [
      healthy,
      snapshot(0),
      snapshot(59_999),
      snapshot(null),
      sustained,
      recovered,
    ]) {
      collectGatewayHealthSnapshotMock.mockResolvedValueOnce(summary);
      await expect(healthState.refreshGatewayHealthSnapshot({ probe: false })).resolves.toBe(
        summary,
      );
      expect(healthState.getHealthCache()).toBe(summary);
    }
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      healthy,
      sustained,
      recovered,
    ]);
  });

  it("does not let a post-connect passive refresh absorb an explicit probe", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const probeSummary = createHealthSummary();
    probeSummary.channels = {
      example: { accountId: "default", probe: { ok: false, error: "offline" } },
    };
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    const postConnectRefresh = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const explicitProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()).toMatchObject({
      audience: "public",
      probe: false,
      runtimeSnapshot: undefined,
    });
    expect(healthSnapshotCallArg(1)).toMatchObject({
      audience: "public",
      probe: true,
      runtimeSnapshot: undefined,
    });

    probeDeferred.resolve(probeSummary);
    await expect(explicitProbe).resolves.toBe(probeSummary);
    expect(healthState.getHealthCache()).toBe(probeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(probeSummary);

    passiveDeferred.resolve(passiveSummary);
    await expect(postConnectRefresh).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);
    expect(healthState.getHealthVersion()).toBe(version + 2);
    expect(broadcast.mock.calls.map(([summary]) => summary)).toEqual([
      probeSummary,
      passiveSummary,
    ]);
  });

  it("coalesces concurrent explicit probe waiters", async () => {
    const healthState = await loadHealthState();
    const probeDeferred = createPendingHealthSnapshot();
    const probeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock.mockImplementationOnce(probeDeferred.collect);

    const first = healthState.refreshGatewayHealthSnapshot({ probe: true });
    const second = healthState.refreshGatewayHealthSnapshot({ probe: true });

    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(1);
    probeDeferred.resolve(probeSummary);
    await expect(Promise.all([first, second])).resolves.toEqual([probeSummary, probeSummary]);
  });

  it("retains a displaced passive refresh after a faster probe settles", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect);

    const firstPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    const secondPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    passiveDeferred.resolve(passiveSummary);
    await expect(Promise.all([firstPassive, secondPassive])).resolves.toEqual([
      passiveSummary,
      passiveSummary,
    ]);
  });

  it.each([
    { includeSensitive: false, reset: false },
    { includeSensitive: false, reset: true },
    { includeSensitive: true, reset: false },
    { includeSensitive: true, reset: true },
  ])(
    "publishes current event-loop health after collection ($includeSensitive, $reset)",
    async ({ includeSensitive, reset }) => {
      const healthState = await loadHealthState();
      const initial = {
        degraded: true,
        degradedSinceMs: 61_000,
        reasons: ["event_loop_delay" as const],
        intervalMs: 2_000,
        delayP99Ms: 1_500,
        delayMaxMs: 1_700,
        utilization: 0.2,
        cpuCoreRatio: 0.1,
      };
      let current: GatewayEventLoopHealth | undefined = initial;
      const started = createDeferred();
      const release = createDeferred();
      const broadcast = vi.fn();
      healthState.setBroadcastHealthUpdate(broadcast);
      collectGatewayHealthSnapshotMock.mockImplementationOnce(
        async (params: { eventLoop?: HealthSummary["eventLoop"] }) => {
          started.resolve();
          await release.promise;
          return {
            ...createHealthSummary(),
            ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
          };
        },
      );
      const pending = healthState.refreshGatewayHealthSnapshot({
        probe: true,
        includeSensitive,
        getEventLoopHealth: () => current,
      });
      await started.promise;
      current = reset
        ? undefined
        : { ...initial, delayP99Ms: 20, delayMaxMs: 25, cpuCoreRatio: 1.2 };
      release.resolve();
      const result = await pending;
      expect(result.eventLoop).toBe(current);
      if (includeSensitive) {
        expect(broadcast).not.toHaveBeenCalled();
      } else {
        expect(healthState.getHealthCache()).toBe(result);
        expect(broadcast).toHaveBeenCalledExactlyOnceWith(result);
      }
    },
  );

  it("passes the config reloader hot-reload status only when the hook returns one", async () => {
    const healthState = await loadHealthState();

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getConfigReloaderHotReloadStatus: () => "disabled",
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getConfigReloaderHotReloadStatus: () => undefined,
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(healthSnapshotCallArg()?.configReloadHotReloadStatus).toBe("disabled");
    expect(Object.hasOwn(healthSnapshotCallArg(1) ?? {}, "configReloadHotReloadStatus")).toBe(
      false,
    );
  });

  it("captures runtime snapshots for completed refreshes and guards snapshot failures", async () => {
    const healthState = await loadHealthState();
    const runtimeSnapshot = {
      channels: { discord: { accountId: "default", connected: true } },
      channelAccounts: {},
    };

    await healthState.refreshGatewayHealthSnapshot({
      probe: false,
      getRuntimeSnapshot: () => runtimeSnapshot,
    });
    await healthState.refreshGatewayHealthSnapshot({
      probe: true,
      getRuntimeSnapshot: () => {
        throw new Error("bad channel config");
      },
    });

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls
        .map((_call, index) => healthSnapshotCallArg(index)?.probe)
        .toSorted((a, b) => Number(a) - Number(b)),
    ).toEqual([false, true]);
    expect(
      collectGatewayHealthSnapshotMock.mock.calls.map(
        (_call, index) => healthSnapshotCallArg(index)?.audience,
      ),
    ).toEqual(["public", "public"]);
    expect(healthSnapshotCallArg()?.runtimeSnapshot).toBe(runtimeSnapshot);
    expect(healthSnapshotCallArg(1)?.runtimeSnapshot).toBeUndefined();
  });

  it("does not cache or broadcast sensitive health refreshes", async () => {
    const healthState = await loadHealthState();
    const sensitiveSummary = createHealthSummary();
    const safeSummary = createHealthSummary();
    const broadcast = vi.fn();
    collectGatewayHealthSnapshotMock
      .mockResolvedValueOnce(sensitiveSummary)
      .mockResolvedValueOnce(safeSummary);
    healthState.setBroadcastHealthUpdate(broadcast);
    const version = healthState.getHealthVersion();

    await healthState.refreshGatewayHealthSnapshot({ probe: true, includeSensitive: true });

    expect(healthState.getHealthCache()).toBeNull();
    expect(healthState.getHealthVersion()).toBe(version);
    expect(broadcast).not.toHaveBeenCalled();

    await healthState.refreshGatewayHealthSnapshot({ probe: false });

    expect(healthState.getHealthCache()).toBe(safeSummary);
    expect(healthState.getHealthVersion()).toBe(version + 1);
    expect(broadcast).toHaveBeenCalledWith(safeSummary);
  });

  it("keeps strength-aware admin and public refresh lanes isolated", async () => {
    const healthState = await loadHealthState();
    const adminPassiveDeferred = createPendingHealthSnapshot();
    const publicProbeDeferred = createPendingHealthSnapshot();
    const adminProbeDeferred = createPendingHealthSnapshot();
    const adminPassiveSummary = createHealthSummary();
    const publicProbeSummary = createHealthSummary();
    const adminProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(adminPassiveDeferred.collect)
      .mockImplementationOnce(publicProbeDeferred.collect)
      .mockImplementationOnce(adminProbeDeferred.collect);

    const adminPassive = healthState.refreshGatewayHealthSnapshot({
      probe: false,
      includeSensitive: true,
    });
    await adminPassiveDeferred.started;
    const publicProbe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await publicProbeDeferred.started;
    const publicPassive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    const adminProbe = healthState.refreshGatewayHealthSnapshot({
      probe: true,
      includeSensitive: true,
    });
    await adminProbeDeferred.started;

    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthSnapshotCallArg()?.audience).toBe("admin");
    expect(healthSnapshotCallArg(1)?.audience).toBe("public");
    expect(healthSnapshotCallArg(2)?.audience).toBe("admin");
    expect(healthSnapshotCallArg()?.probe).toBe(false);
    expect(healthSnapshotCallArg(1)?.probe).toBe(true);
    expect(healthSnapshotCallArg(2)?.probe).toBe(true);

    adminProbeDeferred.resolve(adminProbeSummary);
    publicProbeDeferred.resolve(publicProbeSummary);
    adminPassiveDeferred.resolve(adminPassiveSummary);

    await expect(adminProbe).resolves.toBe(adminProbeSummary);
    await expect(Promise.all([publicProbe, publicPassive])).resolves.toEqual([
      publicProbeSummary,
      publicProbeSummary,
    ]);
    await expect(adminPassive).resolves.toBe(adminPassiveSummary);
    expect(healthState.getHealthCache()).toBe(publicProbeSummary);
  });

  it("recovers each strength lane after rejection without discarding an older success", async () => {
    const healthState = await loadHealthState();
    const passiveDeferred = createPendingHealthSnapshot();
    const probeDeferred = createPendingHealthSnapshot();
    const passiveSummary = createHealthSummary();
    const recoveredProbeSummary = createHealthSummary();
    collectGatewayHealthSnapshotMock
      .mockImplementationOnce(passiveDeferred.collect)
      .mockImplementationOnce(probeDeferred.collect)
      .mockResolvedValueOnce(recoveredProbeSummary);

    const passive = healthState.refreshGatewayHealthSnapshot({ probe: false });
    await passiveDeferred.started;
    const probe = healthState.refreshGatewayHealthSnapshot({ probe: true });
    await probeDeferred.started;
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(2);
    probeDeferred.reject(new Error("probe failed"));
    await expect(probe).rejects.toThrow("probe failed");

    passiveDeferred.resolve(passiveSummary);
    await expect(passive).resolves.toBe(passiveSummary);
    expect(healthState.getHealthCache()).toBe(passiveSummary);

    await expect(healthState.refreshGatewayHealthSnapshot({ probe: true })).resolves.toBe(
      recoveredProbeSummary,
    );
    expect(collectGatewayHealthSnapshotMock).toHaveBeenCalledTimes(3);
    expect(healthState.getHealthCache()).toBe(recoveredProbeSummary);
  });
});
