import { afterAll, beforeAll, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { bindCronJobAdmittedRun, clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { cronJobNeedsCreatorReauthorization } from "./tools-allow.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronStoredJob } from "./types.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

beforeAll(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-cron-script-reauthorization-" });
});

afterAll(async () => {
  await state.cleanup();
});

it("flags reauthorization exactly when script preparation reaches the missing-channel guard", async () => {
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  try {
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    };
    setRuntimeConfigSnapshot(config, config);
    const registry = createTestRegistry([]);
    setActivePluginRegistry(registry);
    const runtime = createCronScriptRuntime({ config, loadPluginRegistry: () => registry });
    const signal = new AbortController().signal;
    const ownerSessionKey = "agent:main:telegram:work:direct:123";
    const cases = [
      ["payload", [], 'return { notify: "done" };', false],
      ["trigger", [], "return { fire: false };", false],
      ["payload", [], "return { notify: typeof MCP };", true],
      ["trigger", [], 'return { fire: typeof MCP === "object" };', true],
      ["payload", ["read"], 'return { notify: "done" };', true],
    ] as const;
    for (const [index, [entry, toolsAllow, script, blocked]] of cases.entries()) {
      const jobId = `reauthorization-${index}`;
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      const job: CronStoredJob = makeCronJob({
        id: jobId,
        agentId: "main",
        payload:
          entry === "payload"
            ? { kind: "script", script, toolsAllow: [...toolsAllow] }
            : { kind: "command", argv: ["true"], toolsAllow: [...toolsAllow] },
        ...(entry === "trigger" ? { trigger: { script } } : {}),
        owner: { agentId: "main", sessionKey: ownerSessionKey, accountId: "work" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey,
          ownerAccountId: "work",
        },
      });
      const params = {
        job,
        script,
        state: null,
        abortSignal: signal,
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        executionIdentity: {
          ingress: { kind: "schedule", boundary: "cron.script", state: "present" } as const,
          onPostAdmission: (admitted) => bindCronJobAdmittedRun(marker, admitted, signal),
        },
      } satisfies Parameters<typeof runtime.evaluateTrigger>[0];
      try {
        const result = await (entry === "trigger"
          ? runtime.evaluateTrigger(params)
          : runtime.executePayload(params));
        expect(result, JSON.stringify(result)).toMatchObject(
          blocked
            ? { kind: "error", error: expect.stringContaining("no recorded creator channel") }
            : { kind: entry === "trigger" ? "evaluated" : "completed" },
        );
      } finally {
        clearCronJobActive(jobId, marker);
      }
      const label = `${entry} ${JSON.stringify(toolsAllow)}: ${script}`;
      expect(cronJobNeedsCreatorReauthorization({ job }), label).toBe(blocked);
    }
  } finally {
    clearRuntimeConfigSnapshot();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
});
