// Boundary repro for PR2: a live multi-agent gateway (3+ agents, NO default:true) proves the
// shipped TUI /models path carries the selected agentId and returns a scoped catalog (not
// INVALID_REQUEST, not a throw), and that the unscoped self-poll model-catalog read
// (chat-metadata projection path) degrades instead of throwing AgentSelectionRequiredError.
//
// Uses the real in-process gateway (startGatewayServer) + real GatewayClient WS transport and
// the real resolveInputs producer - NOT stubs - so this exercises shipped behavior the unit
// tests (mocked client.request + buildAllowedModelSet) cannot.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/config.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GatewayClient } from "./client.js";
import { loadGatewayModelCatalogSnapshot } from "./server-model-catalog.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";
import {
  configureManualGatewayBackgroundEnv,
  MANUAL_GATEWAY_ENV_KEYS,
} from "./test-helpers.manual-gateway-env.js";

const TEST_ENV_KEYS = [
  "HOME",
  ...MANUAL_GATEWAY_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
];

type ModelsListClient = InstanceType<typeof GatewayClient>;

// Three explicit agents, no default:true - the exact 38x-ASE trigger roster. The heartbeat
// owner is named explicitly (agents.defaults.heartbeat.agentId) so the unrelated ambient
// heartbeat scheduler does not itself throw AgentSelectionRequiredError; this does NOT add
// default:true to any roster entry, so the model-catalog ASE trigger is untouched.
function multiAgentNoDefaultConfig(port: number, token: string): Record<string, unknown> {
  return {
    gateway: { port, auth: { mode: "token", token } },
    agents: {
      ownership: "explicit",
      entries: { main: {}, voice: {}, ratbot: {} },
      defaults: { heartbeat: { agentId: "main" } },
    },
  };
}

function isStartupUnavailable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string" &&
    (err as { message: string }).message.includes("gateway startup")
  );
}

// Wait out the transient gateway startup phase. The client already treats the structured
// startup-unavailable error as retryable (resolveGatewayStartupRetryAfterMs); polling a scoped
// models.list until it clears asserts the terminal outcome, not a mask of readiness.
async function waitForModelsListStartupReady(
  client: ModelsListClient,
  deadlineMs = 60_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await client.request("models.list", { agentId: "voice" });
      return;
    } catch (err) {
      if (!isStartupUnavailable(err)) {
        throw err;
      }
      if (Date.now() - start >= deadlineMs) {
        throw err;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }
}

describe("PR2 gateway model-catalog self-poll boundary", () => {
  const envSnapshot = captureEnv(TEST_ENV_KEYS);

  afterEach(async () => {
    envSnapshot.restore();
    clearRuntimeConfigSnapshot();
    deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    deleteTestEnvValue("OPENCLAW_GATEWAY_URL");
    deleteTestEnvValue("OPENCLAW_GATEWAY_TOKEN");
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
  });

  it("TUI /models on a 3-agent no-default gateway carries agentId and returns a scoped catalog", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr2-boundary-"));
    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    configureManualGatewayBackgroundEnv(tempHome);

    const port = await getGatewayE2ePortBlock();
    const token = "pr2-boundary-token";
    const url = `ws://127.0.0.1:${port}`;
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    const config = multiAgentNoDefaultConfig(port, token);
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    clearRuntimeConfigSnapshot();

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    try {
      const client = await connectGatewayClient({
        url,
        token,
        clientDisplayName: "pr2 boundary tui",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        timeoutMs: 60_000,
      });
      try {
        await waitForModelsListStartupReady(client);

        // The real TUI /models path (tui-command-handlers.ts) calls
        // client.listModels({ agentId: selection.agentId }) -> request("models.list", { agentId }).
        // A known agentId must return a scoped catalog, NOT INVALID_REQUEST.
        const scoped = await client.request<{ models?: unknown[] }>("models.list", {
          agentId: "voice",
        });
        expect(Array.isArray(scoped.models)).toBe(true);

        // Counterfactual proves the roster is genuinely no-default: an UNSCOPED models.list
        // (what the TUI would send before the PR2 agentId threading) hits the
        // AgentSelectionRequiredError catch and responds INVALID_REQUEST.
        await expect(client.request("models.list", {})).rejects.toMatchObject({
          gatewayCode: "INVALID_REQUEST",
        });
      } finally {
        await disconnectGatewayClient(client);
      }
    } finally {
      await server.close();
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }, 120_000);

  it("unscoped self-poll model-catalog read on a 3-agent no-default gateway does not throw AgentSelectionRequiredError", async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr2-selfpoll-"));
    const stateDir = path.join(tempHome, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    configureManualGatewayBackgroundEnv(tempHome);

    const port = await getGatewayE2ePortBlock();
    const token = "pr2-selfpoll-token";
    setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(port));

    const config = multiAgentNoDefaultConfig(port, token);
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    clearRuntimeConfigSnapshot();

    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });

    try {
      // The unscoped self-poll read (chat-metadata / chat.startup projection path in
      // session-utils-model.ts) calls loadGatewayModelCatalogSnapshot() with NO agentId.
      // On base resolveInputs this throws AgentSelectionRequiredError; the PR2 degrade
      // converts it to the ambient no-owner shape so the read resolves.
      await expect(loadGatewayModelCatalogSnapshot()).resolves.toBeDefined();
    } finally {
      await server.close();
      await fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }, 120_000);
});
