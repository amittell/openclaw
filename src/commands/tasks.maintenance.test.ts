import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import * as flowMaintenance from "../tasks/task-flow-registry.maintenance.js";
import * as taskMaintenance from "../tasks/task-registry.maintenance.js";
import * as sessionMaintenance from "./tasks-session-registry-maintenance.js";
import { tasksMaintenanceCommand } from "./tasks.js";

const gateway = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../gateway/call.js", () => gateway);
const summary = { reconciled: 2, recovered: 0, cleanupStamped: 1, pruned: 3 };
function runtime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}
const localRead = () => {
  throw new Error("unexpected local maintenance access");
};

// An explicitly remote operation cannot audit or mutate the invoking CLI host.
describe("tasks maintenance Gateway mode", () => {
  beforeEach(() => {
    gateway.callGateway.mockReset().mockResolvedValue(summary);
    vi.spyOn(taskMaintenance, "configureTaskRegistryMaintenance").mockImplementation(localRead);
    vi.spyOn(taskMaintenance, "runTaskRegistryMaintenance").mockImplementation(localRead);
    vi.spyOn(taskMaintenance, "getInspectableTaskAuditSummary").mockImplementation(localRead);
    vi.spyOn(flowMaintenance, "assertTaskFlowRegistryMaintenanceReady").mockImplementation(
      localRead,
    );
    vi.spyOn(sessionMaintenance, "runSessionRegistryMaintenance").mockImplementation(localRead);
  });
  afterEach(() => vi.restoreAllMocks());
  function expectNoLocalAccess() {
    expect(taskMaintenance.configureTaskRegistryMaintenance).not.toHaveBeenCalled();
    expect(taskMaintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
    expect(taskMaintenance.getInspectableTaskAuditSummary).not.toHaveBeenCalled();
    expect(flowMaintenance.assertTaskFlowRegistryMaintenanceReady).not.toHaveBeenCalled();
    expect(sessionMaintenance.runSessionRegistryMaintenance).not.toHaveBeenCalled();
  }
  it("sends a closed request and prints only Gateway counts", async () => {
    const output = runtime();
    await tasksMaintenanceCommand({ gateway: true, apply: true, json: true }, output);
    expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "tasks.maintenance",
      params: {},
      timeoutMs: 10_000,
    });
    expect(JSON.parse(String(vi.mocked(output.log).mock.calls[0]?.[0]))).toEqual({
      mode: "apply",
      authority: "gateway",
      maintenance: { tasks: summary },
    });
    expect(output.exit).not.toHaveBeenCalled();
    expectNoLocalAccess();
  });
  it("labels human output with Gateway authority", async () => {
    const output = runtime();
    await tasksMaintenanceCommand({ gateway: true, apply: true }, output);
    expect(output.log).toHaveBeenCalledWith(
      expect.stringContaining("Gateway task maintenance (applied): 2 reconcile"),
    );
    expectNoLocalAccess();
  });
  it.each([false, true])("requires explicit apply before RPC in JSON=%s", async (json) => {
    const output = runtime();
    await tasksMaintenanceCommand({ gateway: true, json }, output);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(output.exit).toHaveBeenCalledWith(1);
    expect(String(vi.mocked(json ? output.log : output.error).mock.calls[0]?.[0])).toContain(
      "requires --apply",
    );
    expectNoLocalAccess();
  });
  it.each(["operator.admin required", "registry restoration unavailable", "connection closed"])(
    "reports %s without an offline fallback",
    async (message) => {
      gateway.callGateway.mockRejectedValue(new Error(message));
      const output = runtime();
      await tasksMaintenanceCommand({ gateway: true, apply: true, json: true }, output);
      expect(JSON.parse(String(vi.mocked(output.log).mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining(message) },
      });
      expect(output.exit).toHaveBeenCalledWith(1);
      expectNoLocalAccess();
    },
  );
});
