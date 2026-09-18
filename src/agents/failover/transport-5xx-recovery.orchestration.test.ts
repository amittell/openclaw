// A provider 5xx over a real socket, through the shipped OpenAI Responses
// transport, into the production run loop and the outer model-fallback owner
// (runEmbeddedAgentEntry -> runWithModelFallback -> runEmbeddedAgent). The only
// replaced seam is the attempt's session runtime: each attempt sends its prompt
// to the attempt's resolved model over the real transport and returns the
// transport's own terminal message. Backoff sleeps are stubbed, as in the
// model-fallback e2e suite, so the transient retry window never closes.
import { createServer, type RequestListener } from "node:http";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import {
  makeModelFallbackConfig,
  withModelFallbackWorkspace,
  writeFallbackAuthStore,
} from "../model-fallback.run-embedded.e2e.test-support.js";
import {
  createResolvedEmbeddedRunnerModel,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBackoffE2eMocks,
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";

const CLOUDFLARE_ERROR_PAGE = (status: number) =>
  `<!doctype html><html><head><title>${status}</title></head>` +
  `<body><h1>${status}</h1><p>cloudflare-nginx</p></body></html>`;
const BACKUP_REPLY = "recovered on the fallback model";
const RETRY_LIMIT_ERROR = "Exceeded retry limit after 32 attempts (counted attempts=32, max=32).";
const RETRY_LIMIT_PAYLOAD =
  "Request failed after repeated internal retries. Please try again, or use /new to start a fresh session.";
// What a production attempt reports from `retry.provider.maxRetries` (attempt.ts).
// At 32 the same-model retries outlast the one-profile run budget of 32 counted
// attempts, so the run loop itself reaches its retry-limit decision.
const PROVIDER_MAX_RETRIES_ABOVE_RUN_BUDGET = 32;

type EntryBehavior = "maintenance" | "command-rpc";
const baseUrlByProvider = new Map<string, string>();
let providerMaxRetries: number | undefined;

async function sendAttemptOverRealTransport(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const stream = await createOpenAIResponsesTransportStreamFn()(
    params.model,
    { messages: [{ role: "user", content: params.prompt, timestamp: 0 }], tools: [] },
    { apiKey: "test-key" },
  );
  let assistant: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") {
      assistant = event.message;
    } else if (event.type === "error") {
      assistant = event.error;
    }
  }
  if (!assistant) {
    throw new Error("The transport produced no terminal message");
  }
  const text = assistant.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return {
    ...makeEmbeddedRunnerAttempt({ assistantTexts: text ? [text] : [], lastAssistant: assistant }),
    ...(providerMaxRetries === undefined ? {} : { providerRetryMaxRetries: providerMaxRetries }),
  };
}

let runEmbeddedAgent: typeof import("../embedded-agent-runner/run.js").runEmbeddedAgent;
let runEmbeddedAgentEntry: typeof import("../embedded-agent-runner/run-entry.js").runEmbeddedAgentEntry;
let createModelRoutingTestAdmission: typeof import("../test-helpers/model-routing-decision-e2e-fixtures.js").createModelRoutingTestAdmission;

beforeAll(async () => {
  vi.doMock("../models-config.js", () => ({
    ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
  }));
  vi.doMock("../../plugins/runtime.js", () => ({
    getActivePluginRegistry: () => null,
    getActivePluginRegistryWorkspaceDir: () => undefined,
    requireActivePluginRegistry: () => ({}),
  }));
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: sendAttemptOverRealTransport });
  installEmbeddedRunnerBackoffE2eMocks({
    computeBackoff: () => 0,
    sleepWithAbort: async () => undefined,
  });
  vi.doMock("../embedded-agent-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) =>
      createResolvedEmbeddedRunnerModel(provider, modelId, {
        baseUrl: baseUrlByProvider.get(provider),
      }),
  }));
  ({ runEmbeddedAgent } = await import("../embedded-agent-runner/run.js"));
  ({ runEmbeddedAgentEntry } = await import("../embedded-agent-runner/run-entry.js"));
  ({ createModelRoutingTestAdmission } =
    await import("../test-helpers/model-routing-decision-e2e-fixtures.js"));
});

async function startLoopbackProvider(respond: RequestListener) {
  const counter = { requests: 0 };
  const server = createServer((request, response) => {
    counter.requests += 1;
    request.resume();
    request.on("end", () => respond(request, response));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  return {
    counter,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const completedResponse = {
  type: "response.completed",
  sequence_number: 0,
  response: {
    id: "resp-backup",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg-backup",
        role: "assistant",
        content: [{ type: "output_text", text: BACKUP_REPLY }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  },
};

async function runPrimaryOutage(status: number, behavior: EntryBehavior) {
  const primary = await startLoopbackProvider((_request, response) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(CLOUDFLARE_ERROR_PAGE(status));
  });
  const backup = await startLoopbackProvider((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.end(`event: response.completed\ndata: ${JSON.stringify(completedResponse)}\n\n`);
  });
  // makeModelFallbackConfig: primary openai/mock-1, configured fallback groq/mock-2.
  baseUrlByProvider.set("openai", primary.baseUrl);
  baseUrlByProvider.set("groq", backup.baseUrl);
  try {
    return await withModelFallbackWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeFallbackAuthStore(agentDir);
      const cfg = makeModelFallbackConfig();
      const runId = `run:live-${status}-${behavior}`;
      const sessionId = `session:${runId}`;
      const sessionKey = `agent:test:live-${status}-${behavior}`;
      const admission = createModelRoutingTestAdmission({ cfg, runId, boundary: "live-5xx" });
      try {
        const run = await runEmbeddedAgentEntry({
          selection: { cfg, provider: "openai", model: "mock-1", agentDir, manifestPlugins: [] },
          identity: { runId, agentId: "test", sessionId, sessionKey },
          harness: {
            workspaceDir,
            sessionKey,
            preparation: { kind: "direct" },
            resolveRuntimeOverride: () => undefined,
            resolveContextEngineHost: (provider, model) => ({
              id: `live-5xx:${provider}/${model}`,
              label: "live 5xx orchestration",
              capabilities: [],
            }),
          },
          // maintenance: no result-payload fallback (memory flush entry).
          // command-rpc: result payloads are classified for fallback (cron entry).
          behavior:
            behavior === "maintenance"
              ? { kind: "maintenance" }
              : { kind: "command-rpc", hasCommittedSideEffect: () => false },
          sessionOverride: { kind: "preserve" },
          runCandidate: (provider, model, options) =>
            runEmbeddedAgent({
              preparedRunAdmission: admission,
              sessionId,
              sessionKey,
              workspaceDir,
              agentDir,
              config: cfg,
              prompt: "ping",
              provider,
              model,
              modelRoutingProvenance: options.modelRoutingProvenance,
              authProfileIdSource: "auto",
              allowTransientCooldownProbe: options.allowTransientCooldownProbe,
              isFinalFallbackAttempt: options.isFinalFallbackAttempt,
              assistantErrorTranscript: options.assistantErrorTranscript,
              timeoutMs: 5_000,
              runId,
              enqueue: async (task) => await task(),
              contextEngineLogicalTurnLease: options.contextEngineLogicalTurnLease,
              onContextEngineTurnCandidate: options.onContextEngineTurnCandidate,
            }),
        });
        const proof = {
          status,
          entry: behavior,
          primaryRequests: primary.counter.requests,
          backupRequests: backup.counter.requests,
          winner: `${run.provider}/${run.model}`,
          reply: run.result.payloads?.map((payload) => payload.text).join("") ?? "",
          // Absent fields stay undefined: JSON drops them and toEqual ignores them.
          handoff: run.attempts.map((attempt) => ({
            reason: attempt.reason,
            code: attempt.code,
            status: attempt.status,
            error: attempt.error,
          })),
        };
        console.log(`[live 5xx orchestration proof] ${JSON.stringify(proof)}`);
        return proof;
      } finally {
        admission.close();
      }
    });
  } finally {
    await primary.close();
    await backup.close();
  }
}

describe("provider 5xx recovery through production model-fallback orchestration", () => {
  describe("at retry-limit exhaustion", () => {
    beforeAll(() => {
      providerMaxRetries = PROVIDER_MAX_RETRIES_ABOVE_RUN_BUDGET;
    });

    it("hands a live 502 to the configured fallback model, which answers", async () => {
      const proof = await runPrimaryOutage(502, "maintenance");
      // The automatic fallback: production selected and executed the backup.
      expect({
        winner: proof.winner,
        backupRequests: proof.backupRequests,
        reply: proof.reply,
      }).toEqual({ winner: "groq/mock-2", backupRequests: 1, reply: BACKUP_REPLY });
      // It came from the run loop's retry-limit FailoverError, not a payload.
      expect(proof.primaryRequests).toBe(32);
      expect(proof.handoff).toEqual([
        { reason: "server_error", status: 500, error: RETRY_LIMIT_ERROR },
      ]);
    });

    it("keeps a live 504 local: retry-limit returns its error payload, no backup request", async () => {
      const proof = await runPrimaryOutage(504, "maintenance");
      expect(proof).toMatchObject({
        primaryRequests: 32,
        backupRequests: 0,
        winner: "openai/mock-1",
        reply: RETRY_LIMIT_PAYLOAD,
        handoff: [],
      });
    });

    it("on a payload-classifying entry, a 504 still recovers but only through its payload", async () => {
      // Since #143649 a timeout payload is fallback-eligible, so the cron-style
      // entry reaches the backup either way; the handoff differs.
      const outage502 = await runPrimaryOutage(502, "command-rpc");
      const outage504 = await runPrimaryOutage(504, "command-rpc");
      expect([outage502.winner, outage502.reply, outage502.handoff]).toEqual([
        "groq/mock-2",
        BACKUP_REPLY,
        [{ reason: "server_error", status: 500, error: RETRY_LIMIT_ERROR }],
      ]);
      expect([outage504.winner, outage504.reply, outage504.handoff]).toEqual([
        "groq/mock-2",
        BACKUP_REPLY,
        [{ reason: "timeout", code: "embedded_error_payload", error: RETRY_LIMIT_PAYLOAD }],
      ]);
    });
  });

  describe("at the default provider retry setting", () => {
    beforeAll(() => {
      providerMaxRetries = undefined;
    });

    it.each([
      { status: 502, reason: "server_error" },
      { status: 504, reason: "timeout" },
    ])(
      "falls back from the assistant stage after 9 live $status requests, recorded $reason",
      async ({ status, reason }) => {
        const proof = await runPrimaryOutage(status, "maintenance");
        expect(proof).toMatchObject({
          primaryRequests: 9,
          backupRequests: 1,
          winner: "groq/mock-2",
          reply: BACKUP_REPLY,
          handoff: [{ reason, status, error: `${status} ${CLOUDFLARE_ERROR_PAGE(status)}` }],
        });
      },
    );
  });
});
