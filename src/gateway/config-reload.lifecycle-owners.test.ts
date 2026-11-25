import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushWatcherChange,
  getOnlyRestartCall,
  makeSnapshot,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";

afterEach(closeTestConfigReloaders);

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.audit.js")>();
  return {
    ...actual,
    appendConfigAuditRecord: configAuditMocks.append,
  };
});

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config-journal-snapshot.js")>();
  return {
    ...actual,
    readLatestConfigSnapshotAuditRecordAsync: configAuditMocks.readLatestSnapshot,
    upsertConfigSnapshotAuditRecordAsync: configAuditMocks.upsertSnapshot,
  };
});

beforeEach((context) => {
  prepareConfigReloadTest(context);
  configAuditMocks.append.mockReset();
  configAuditMocks.readLatestSnapshot.mockReset().mockReturnValue(null);
  configAuditMocks.upsertSnapshot.mockReset();
});

describe("startGatewayConfigReloader", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await closeTestConfigReloaders();
    clearCurrentPluginMetadataSnapshot();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("notifies lifecycle owners when hybrid mode applies a restart-only change", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, port: 18789 },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hybrid" }, port: 18790 },
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "hot" }));
    const harness = createReloaderHarness(readSnapshot, { initialConfig });
    await harness.reloader.ready;

    await flushWatcherChange(harness);

    // Hybrid mode must not silently drop restart-required changes: it queues
    // the restart and notifies lifecycle owners so runtime state cannot go
    // stale, and logs why a hot-capable reload ended in a restart.
    expect(harness.onConfigChange).toHaveBeenCalledOnce();
    expect(harness.onHotReload).not.toHaveBeenCalled();
    const [plan] = getOnlyRestartCall(harness);
    expect(plan.restartReasons).toEqual(["gateway.port"]);
    expect(harness.log.warn).toHaveBeenCalledWith(
      "config reload requires gateway restart; hybrid mode scheduling restart (gateway.port)",
    );
    await harness.reloader.stop();
  });
});
