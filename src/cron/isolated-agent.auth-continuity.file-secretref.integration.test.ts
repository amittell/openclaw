// Fork carry of upstream #173411 onto v2026.10.10-beta.4: the bots' legacy automations authenticate with a
// custom provider's apiKey held as a file SecretRef (a singleValue secrets provider), and mac-mini also declares
// an auth profile for that provider that most agents' stores do not hold. Before the carry every such run was
// refused with "Automation has no recorded inference account"; it must keep running on the configured key.
import fs from "node:fs/promises";
import path from "node:path";
import { getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { disposeAllSessionMcpRuntimes } from "../agents/agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agents/agent-bundle-mcp-manager.test-support.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { unwrapSecretSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import "../llm/ai-transport-host.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent/run.js";
import type { CronStoredJob } from "./types.js";

// Not resolvable, so the local-endpoint preflight cannot reach a real host from the test machine.
const providerUrl = "https://gpufarm.invalid/v1";
const fileKey = "synthetic-file-secret-key";

function model(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
}

function completedChatCompletion(modelId: string): Response {
  const chunk = (delta: object, finishReason: string | null, usage?: object) => ({
    id: "chatcmpl_synthetic",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
  const events = [
    chunk({ role: "assistant", content: "configured key" }, null),
    chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

beforeEach(bindSessionMcpRuntimeTestScheduler);

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  clearSecretsRuntimeSnapshot();
  vi.restoreAllMocks();
});

async function runLegacyBotJob(params: { declaredProfile: boolean }) {
  return await withOpenClawTestState({ label: "cron-legacy-file-secretref" }, async (state) => {
    installPrivateUpdateHandoffStore(state.root);
    const keyFile = path.join(state.root, "gpufarm-bots.key");
    await fs.writeFile(keyFile, `${fileKey}\n`, { mode: 0o600 });
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
        throw new Error(`Unexpected external I/O in cron credential fixture: ${request.url}`);
      }
      // The transport carries the resolved SecretRef as a sentinel; unwrap it as provider egress does.
      const authorization = request.headers.get("authorization");
      requests.push({
        url: request.url,
        authorization: authorization
          ? unwrapSecretSentinelsForProviderEgress(authorization, "the test provider fetch")
          : null,
      });
      return completedChatCompletion("qwen-test");
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
    vi.spyOn(getAiTransportHost(), "buildModelFetch").mockReturnValue(providerFetch);
    const sourceConfig: OpenClawConfig = {
      agents: {
        entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
        defaults: {
          model: { primary: "gpufarm/qwen-test", fallbacks: ["gpufarm/qwen-test-b"] },
          models: {
            "gpufarm/qwen-test": { agentRuntime: { id: "openclaw" } },
            "gpufarm/qwen-test-b": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      // mac-mini declares this profile in config; only one agent's store holds it, never `main`'s.
      ...(params.declaredProfile
        ? { auth: { profiles: { "gpufarm:manual": { provider: "gpufarm", mode: "api_key" } } } }
        : {}),
      secrets: {
        providers: { gpufarm_bots: { source: "file", path: keyFile, mode: "singleValue" } },
      },
      models: {
        mode: "replace",
        providers: {
          gpufarm: {
            api: "openai-completions",
            baseUrl: providerUrl,
            apiKey: { source: "file", provider: "gpufarm_bots", id: "value" },
            models: [model("qwen-test"), model("qwen-test-b")],
          },
        },
      },
      plugins: { allow: ["openai"], slots: { memory: "none" } },
      skills: { load: { watch: false } },
      tools: { deny: ["*"] },
    };
    await state.writeConfig(sourceConfig);
    // As the Gateway does at startup: resolve the SecretRefs, then publish the resolved runtime config.
    const secrets = await prepareSecretsRuntimeSnapshot({
      config: sourceConfig,
      agentDirs: [state.agentDir()],
    });
    activateSecretsRuntimeSnapshot(secrets);
    const cfg = secrets.config;
    // Created before account binding: no inferenceBinding, no payload model.
    const job: CronStoredJob = {
      id: "legacy-bot-job",
      name: "Legacy bot job",
      agentId: "main",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 300_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      delivery: { mode: "none" },
      payload: { kind: "agentTurn", message: "Reply.", lightContext: true },
      state: {},
    };
    try {
      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps: {},
        job,
        deliveryAttemptFence: null,
        message: "Reply.",
        sessionKey: "cron:legacy-bot-job",
        lane: "cron",
      });
      return { result, requests };
    } finally {
      await resetPreparedModelRuntimeSnapshotsForTest();
    }
  });
}

describe("legacy bot automations on a file SecretRef provider key", () => {
  it.each([
    { shape: "rh-bot: no declared profile", declaredProfile: false },
    { shape: "mac-mini: a declared profile the agent store does not hold", declaredProfile: true },
  ])("keeps running on the configured key ($shape)", async ({ declaredProfile }) => {
    const { result, requests } = await runLegacyBotJob({ declaredProfile });

    expect(result.status, result.error).toBe("ok");
    expect(requests).toEqual([
      { url: `${providerUrl}/chat/completions`, authorization: `Bearer ${fileKey}` },
    ]);
  });
});
