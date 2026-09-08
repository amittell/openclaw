import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as subagentRegistry from "../../agents/subagents/registry/subagent-registry.js";
import { createSubagentTaskReconciler } from "../../agents/subagents/registry/subagent-task-liveness.js";
import {
  upsertSessionEntryCore,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { getTaskById, publishTaskRecordAfterAtomicStore } from "../../tasks/runtime-internal.js";
import * as maintenance from "../../tasks/task-registry.maintenance.js";
import { upsertTaskRegistryRecordToSqlite } from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS } from "../control-plane-rate-limit.js";
import { handleGatewayRequest } from "../server-methods.js";
import { tasksHandlers } from "./tasks.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const summary = { reconciled: 1, recovered: 0, cleanupStamped: 0, pruned: 0 };
let sequence = 0;
function client(scopes = ["operator.admin"]): GatewayClient {
  return {
    connId: `maintenance-${++sequence}`,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
    },
  };
}
async function dispatch(
  options: {
    client?: GatewayClient;
    params?: Record<string, unknown>;
    startup?: boolean;
  } = {},
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "maintenance",
      method: "tasks.maintenance",
      params: options.params ?? {},
    },
    client: options.client ?? client(),
    respond,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
      ...(options.startup ? { unavailableGatewayMethods: new Set(["tasks.maintenance"]) } : {}),
    } as unknown as GatewayRequestContext,
    extraHandlers: tasksHandlers,
  });
  return respond;
}

// Exercise the real router and core descriptor; only the native readiness and
// maintenance owner effects are controlled at their public boundary.
describe("Gateway tasks maintenance admission", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.spyOn(subagentRegistry, "isSubagentRegistryRestored").mockReturnValue(true);
    vi.spyOn(maintenance, "runTaskRegistryMaintenance").mockResolvedValue(summary);
  });
  afterEach(() => {
    maintenance.stopTaskRegistryMaintenance();
    maintenance.resetTaskRegistryMaintenanceRuntimeForTests();
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
  });

  it("dispatches admin maintenance through the current Gateway owner", async () => {
    expect(await dispatch()).toHaveBeenCalledWith(true, summary);
    expect(maintenance.runTaskRegistryMaintenance).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(
    [[], ["operator.read"], ["operator.write"], ["operator.read", "operator.write"]].map(
      (scopes) => ({ scopes }),
    ),
  )("rejects insufficient scopes $scopes before owner effects", async ({ scopes }) => {
    expect(await dispatch({ client: client(scopes) })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "FORBIDDEN",
        details: expect.objectContaining({ missingScope: "operator.admin" }),
      }),
    );
    expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
  });
  it("rejects a node even with admin scope", async () => {
    const node = client();
    node.connect.role = "node";
    expect(await dispatch({ client: node })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
  });
  it.each(["runtimeAuthority", "cfg", "agentId", "now", "force"])(
    "rejects caller-controlled %s before owner effects",
    async (field) => {
      expect(await dispatch({ params: { [field]: true } })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
    },
  );
  it("refuses incomplete native restoration without running maintenance", async () => {
    vi.mocked(subagentRegistry.isSubagentRegistryRestored).mockReturnValue(false);
    expect(await dispatch()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
  });
  it("honors startup and suspend admission before owner effects", async () => {
    expect(await dispatch({ startup: true })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    expect(await dispatch()).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
    suspension?.release();
  });
  it("waits for profile authority and fails closed when it is unavailable", async () => {
    const pending = client();
    pending.authenticatedUserId = "operator@example.com";
    pending.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await dispatch({ client: pending })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    expect(maintenance.runTaskRegistryMaintenance).not.toHaveBeenCalled();
  });
  it("charges the normal control-plane write budget", async () => {
    const operator = client();
    for (let i = 0; i < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; i++) {
      expect(await dispatch({ client: operator })).toHaveBeenCalledWith(true, summary);
    }
    expect(await dispatch({ client: operator })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );
    expect(maintenance.runTaskRegistryMaintenance).toHaveBeenCalledTimes(
      CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
    );
  });
  it.each(["absent", "active", "replacement", "cross-agent"] as const)(
    "preserves the canonical native owner decision for %s",
    async (condition) => {
      vi.mocked(maintenance.runTaskRegistryMaintenance).mockRestore();
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const old = Date.now() - 60 * 60_000;
        const child = "agent:main:subagent:gateway-maintenance";
        await upsertSessionEntryCore(
          { sessionKey: child },
          { sessionId: "maintenance-window", updatedAt: old },
        );
        const task: TaskRecord = {
          taskId: "gateway-orphan",
          runtime: "subagent",
          runId: "gateway-orphan-run",
          sourceId: "gateway-orphan-run",
          childSessionKey: child,
          requesterSessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          agentId: "main",
          scopeKind: "session",
          task: "historical task",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: old,
          startedAt: old,
          lastEventAt: old,
        };
        upsertTaskRegistryRecordToSqlite(task);
        publishTaskRecordAfterAtomicStore(task);
        maintenance.configureTaskRegistryMaintenance({
          runtimeAuthoritative: true,
          subagentReconciler: createSubagentTaskReconciler({
            isRegistryRestored: subagentRegistry.isSubagentRegistryRestored,
          }),
        });
        if (condition === "active") {
          registerAgentRunContext(task.runId!, {
            sessionId: "maintenance-window",
            projectSessionActive: false,
          });
        } else if (condition === "replacement") {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (condition === "cross-agent") {
          await upsertSessionEntryCore(
            { sessionKey: "agent:other:subagent:descendant", agentId: "other" },
            { sessionId: "other-window", updatedAt: old, spawnedBy: child },
          );
        }
        const response = await dispatch();
        expect(response).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ reconciled: condition === "absent" ? 1 : 0 }),
        );
        expect(getTaskById(task.taskId)?.status).toBe(condition === "absent" ? "lost" : "running");
        expect(loadSessionEntryReadOnly({ sessionKey: child })?.sessionId).toBe(
          "maintenance-window",
        );
        if (condition === "absent") {
          const lost = getTaskById(task.taskId);
          expect(lost?.error).toContain("historical outcome unknown");
          const repeated = await Promise.all([dispatch(), dispatch()]);
          for (const reply of repeated) {
            expect(reply).toHaveBeenCalledWith(true, expect.objectContaining({ reconciled: 0 }));
          }
          expect(getTaskById(task.taskId)).toEqual(lost);
        }
      });
    },
  );
});
