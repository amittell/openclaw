// Exercise private subagent completions through the real Gateway, runner, registry, and provider HTTP.
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { text as readBody } from "node:stream/consumers";
import { expect, it } from "vitest";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type SpawnReceipt = { status?: string; runId: string; childSessionKey: string };
type ProviderBody = { input?: Array<{ type?: string; call_id?: string; output?: string }> };
const SPAWN_CALL_ID = "call_quiet_spawn";
const SETTLED = new Set(["delivered", "failed", "suspended", "discarded"]);

function writeSpawnCall(response: ServerResponse, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: `fc_${SPAWN_CALL_ID}`,
    call_id: SPAWN_CALL_ID,
    name: "sessions_spawn",
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${randomUUID()}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

it(
  "settles silent and visible private completions in one parent turn",
  { timeout: 120_000 },
  async () => {
    resetGatewayTestState();
    const home = await setupGatewayTempHome({ prefix: "openclaw-quiet-completion-" });
    let completionReply = "NO_REPLY";
    let completionRequests = 0;
    let sequence = 0;
    let parentPrompt = "";
    let childTask = "";
    let childResult = "";
    let releaseChild = createDeferred();
    let childAccepted = createDeferred<SpawnReceipt>();
    const errors: unknown[] = [];
    let model: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    await runQaGatewayFixture(
      async () => {
        model = await startOpenAiResponsesModelServer({
          modelId: "quiet-completion",
          bindError: "Expected quiet completion model server address",
          onRequest: async (request, response) => {
            const raw = await readBody(request);
            const reply = (text: string) => {
              const id = `quiet_${++sequence}`;
              writeOpenAiResponsesText(response, {
                text,
                messageId: id,
                responseId: `${id}_response`,
              });
            };
            if (raw.includes("Generate a concise session title")) {
              reply("Quiet completion proof");
            } else if (raw.includes(parentPrompt)) {
              if (raw.includes(childResult)) {
                // Bound a retried completion turn so the count reports the extra model turn.
                reply(++completionRequests === 1 ? completionReply : "Unexpected extra turn.");
              } else if (!raw.includes(SPAWN_CALL_ID)) {
                writeSpawnCall(response, {
                  task: childTask,
                  context: "isolated",
                  completionTarget: "parent",
                  cleanup: "keep",
                });
              } else {
                const output = (JSON.parse(raw) as ProviderBody).input?.find(
                  (item) => item.type === "function_call_output" && item.call_id === SPAWN_CALL_ID,
                )?.output;
                if (output) {
                  childAccepted.resolve(JSON.parse(output) as SpawnReceipt);
                } else {
                  errors.push(new Error("Missing sessions_spawn receipt"));
                }
                reply("Child accepted.");
              }
            } else {
              await releaseChild.promise;
              reply(childResult);
            }
          },
        });
        const token = randomUUID();
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        const ref = "synthetic/quiet-completion";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: home.workspaceDir,
              skipBootstrap: true,
              model: { primary: ref },
              models: { [ref]: { params: { transport: "sse", openaiWsWarmup: false } } },
              subagents: { allowAgents: ["*"] },
            },
          },
          models: {
            mode: "replace",
            providers: {
              synthetic: {
                baseUrl: `${model.baseUrl}/v1`,
                apiKey: "synthetic-key",
                api: "openai-responses",
                request: { allowPrivateNetwork: true },
                models: [
                  {
                    id: "quiet-completion",
                    name: "quiet-completion",
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          tools: { profile: "coding", toolSearch: false },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
        };
        gateway = await startGatewayWithClient({
          cfg,
          configPath: await createGatewayConfigPath(home.tempHome),
          token,
          scopes: ["operator.admin"],
        });
        await gateway.server.startupSettled;
        for (const text of ["NO_REPLY", "", "The child result is ready."]) {
          completionReply = text;
          completionRequests = 0;
          const key = `quiet_parent_${sequence}`;
          const sessionKey = `agent:main:${key}`;
          parentPrompt = `Spawn research for ${key}.`;
          childTask = `Return research for ${key}.`;
          childResult = `CHILD_RESULT_${key}`;
          releaseChild = createDeferred();
          childAccepted = createDeferred<SpawnReceipt>();
          await gateway.client.request(
            "agent",
            { sessionKey, message: parentPrompt, idempotencyKey: key, deliver: false },
            { expectFinal: true },
          );
          const child = await childAccepted.promise;
          const settled = createDeferred();
          const observe = () => {
            if (SETTLED.has(listSubagentRunsForRequester(sessionKey)[0]?.delivery?.status ?? "")) {
              settled.resolve();
            }
          };
          const stop = subscribeSubagentRunChanges("persistence", observe);
          try {
            releaseChild.resolve();
            observe();
            await settled.promise;
          } finally {
            stop();
          }
          const label = `private completion ${JSON.stringify(text)}`;
          expect(listSubagentRunsForRequester(sessionKey), label).toEqual([
            expect.objectContaining({
              runId: child.runId,
              delivery: expect.objectContaining({ status: "delivered" }),
            }),
          ]);
          expect(completionRequests, label).toBe(1);
          expect(peekSystemEvents(sessionKey).join("\n"), label).not.toContain(
            "delivery is blocked",
          );
          const childHistory = await gateway.client.request("chat.history", {
            sessionKey: child.childSessionKey,
          });
          expect(JSON.stringify(childHistory), label).toContain(childResult);
        }
        expect(errors).toEqual([]);
      },
      () => releaseChild.resolve(),
      () => gateway && disconnectGatewayClient(gateway.client),
      () => gateway?.server.close({ reason: "quiet completion proof complete" }),
      () => model?.close(),
      () => resetSubagentRegistryForTests({ persist: false }),
      () => removeGatewayTempHome(home.tempHome),
      () => home.envSnapshot.restore(),
      resetGatewayTestState,
    );
  },
);
