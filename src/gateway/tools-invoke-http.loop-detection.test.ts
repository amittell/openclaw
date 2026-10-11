// HTTP tool invocations are not model-run tool calls: they run plugin
// before_tool_call hooks, but never feed or trip the session's loop detection.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const TEST_GATEWAY_TOKEN = "test-gateway-token-1234567890";
const SESSION_KEY = "agent:main:main";

const mocks = vi.hoisted(() => ({
  cfg: { tools: { loopDetection: { enabled: true } } },
  execute: vi.fn(async () => ({ content: [{ type: "text", text: "[]" }], details: {} })),
}));

vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => mocks.cfg }));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => mocks.cfg }));
vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  resolveMainSessionKey: () => SESSION_KEY,
}));
vi.mock("./auth.js", () => ({ authorizeHttpGatewayConnect: async () => ({ ok: true }) }));
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: () => [
    {
      name: "sessions_list",
      parameters: { type: "object", properties: {} },
      execute: mocks.execute,
    },
  ],
}));

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let port = 0;
let server: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleToolsInvokeHttpRequest(req, res, {
      auth: { mode: "token", token: TEST_GATEWAY_TOKEN, allowTailscale: false },
    }).catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      port = (server?.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

beforeEach(() => {
  resetDiagnosticSessionStateForTest();
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

async function invokeSessionsList() {
  return await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_GATEWAY_TOKEN}`,
      "x-openclaw-scopes": "operator.write",
    },
    body: JSON.stringify({ tool: "sessions_list", args: { limit: 50 }, sessionKey: "main" }),
  });
}

describe("tools invoke HTTP loop detection", () => {
  it("keeps repeated HTTP calls out of the session's run loop detection", async () => {
    const pluginHook = vi.fn();
    const registry = createMockPluginRegistry([
      { hookName: "before_tool_call", handler: pluginHook, pluginId: "probe" },
    ]);
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const loopWarnings: number[] = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "tool.loop" && event.action === "warn") {
        loopWarnings.push(event.count);
      }
    });
    const runCtx = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      sessionId: "main-session",
      runId: "model-run-1",
      loopDetection: { enabled: true },
    };
    let modelCalls = 0;
    const runCallLoopWarning = async () => {
      const outcome = await runBeforeToolCallHook({
        toolName: "sessions_list",
        params: { limit: 50 },
        toolCallId: `model-call-${(modelCalls += 1)}`,
        ctx: runCtx,
      });
      if (outcome.blocked) {
        throw new Error(`model-run call was blocked: ${outcome.reason}`);
      }
      return outcome.loopWarning;
    };
    try {
      for (let call = 0; call < 10; call += 1) {
        expect(await runCallLoopWarning()).toBeUndefined();
      }
      const runHistory = [...(getDiagnosticSessionState(runCtx).toolCallHistory ?? [])];
      expect(runHistory).toHaveLength(10);
      pluginHook.mockClear();

      for (let call = 0; call < 11; call += 1) {
        const res = await invokeSessionsList();
        expect(res.status).toBe(200);
      }

      expect(mocks.execute).toHaveBeenCalledTimes(11);
      expect(pluginHook).toHaveBeenCalledTimes(11);
      expect(loopWarnings).toEqual([]);
      expect(getDiagnosticSessionState(runCtx).toolCallHistory).toEqual(runHistory);

      // The model run's own eleventh identical call still reaches the warning threshold.
      expect(await runCallLoopWarning()).toMatchObject({
        kind: "tool-loop-warning",
        count: 10,
      });
      expect(loopWarnings).toEqual([10]);
    } finally {
      unsubscribe();
    }
  });
});
