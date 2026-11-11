import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

// openclaw-scheduler agent jobs reuse one session per job (`agent:<agent>:scheduler:<jobId>`)
// and dispatch every run as this request: POST /v1/chat/completions with the Gateway token.
// Each run, and a background command's completion turn, must still be able to run exec.
it(
  "keeps exec on every scheduled run of one session and on its completion turn",
  { timeout: 240_000 },
  async (test) => {
    await runQaGatewayTestFixture(test, async ({ signal, verifyCleanup }) => {
      const gateway = await createOpenClawTestInstance({
        name: "scheduled-dispatch-exec",
        cwd: process.cwd(),
        signal,
        verifyCleanup,
        stopTimeoutMs: 10_000,
        env: { VITEST: undefined, NODE_ENV: "production", OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
      });
      const markers = gateway.state.path("markers");
      fs.mkdirSync(markers, { recursive: true });
      const marker = (name: string) => path.join(markers, `${name}.txt`);
      const offered: Record<string, boolean> = {};
      const outputs: Record<string, string> = {};
      const calls = new Map<string, string>();
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          if (request.method !== "POST") {
            response.writeHead(200).end('{"data":[]}');
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            input?: Array<{
              role?: string;
              type?: string;
              content?: unknown;
              call_id?: string;
              output?: unknown;
            }>;
            tools?: Array<{ name?: string }>;
            instructions?: unknown;
          };
          const input = body.input ?? [];
          const last = input.at(-1);
          if (last?.type === "function_call_output") {
            const name = calls.get(last.call_id ?? "");
            if (name) {
              outputs[name] = JSON.stringify(last.output);
            }
            writeOpenAiResponsesText(response, {
              text: `DONE ${name ?? ""}`,
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
            return;
          }
          // The turn's new input (everything after the model's last output) and its system
          // context, where a completion notice can also arrive.
          const start = input.findLastIndex(
            (item) => item.role === "assistant" || item.type === "function_call",
          );
          const text = JSON.stringify(input.slice(start + 1)) + JSON.stringify(body.instructions);
          const name = [...text.matchAll(/SCHEDULED_(RUN_[0-9]|BACKGROUND|COMPLETION)_(\w+)/gu)]
            .map((match) => match[1]!)
            .findLast((candidate) => !(candidate in offered));
          const hasTools = (body.tools?.length ?? 0) > 0;
          if (!name || !hasTools) {
            writeOpenAiResponsesText(response, {
              text: "OK",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
            return;
          }
          offered[name] = body.tools!.some((tool) => tool.name === "exec");
          if (!offered[name]) {
            writeOpenAiResponsesText(response, {
              text: `NO EXEC ${name}`,
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
            return;
          }
          const command =
            name === "BACKGROUND"
              ? `printf ran > '${marker(name)}'; sleep 3; echo SCHEDULED_COMPLETION_${name}`
              : `printf ran > '${marker(name)}'; echo ran ${name}`;
          const id = randomUUID();
          const args = JSON.stringify(
            name === "BACKGROUND" ? { command, yieldMs: 1000 } : { command },
          );
          calls.set(`call_${id}`, name);
          const item = {
            type: "function_call",
            id: `fc_${id}`,
            call_id: `call_${id}`,
            name: "exec",
            arguments: args,
            status: "completed",
          };
          writeOpenAiResponsesSse(response, [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            },
            {
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: args,
            },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `resp_${id}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ]);
        })().catch((error: unknown) => {
          console.error("Synthetic provider fixture failed", String(error));
          if (!response.destroyed) {
            response.writeHead(500).end();
          }
        });
      });
      await new Promise<void>((resolve) => {
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Provider did not bind");
      }
      const sessionKey = `agent:main:scheduler:${randomUUID()}`;
      // The scheduler's request shape (openclaw-scheduler 0.6.7 gateway.js).
      const dispatch = async (message: string) => {
        const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${gateway.gatewayToken}`,
            "x-openclaw-scopes": "operator.write",
            "x-openclaw-agent-id": "main",
            "x-openclaw-session-key": sessionKey,
          },
          body: JSON.stringify({
            model: "openclaw:main",
            messages: [{ role: "user", content: message }],
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal,
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toMatch(/^data: \[DONE\]$/mu);
      };
      try {
        const provider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
        const config = {
          logging: { file: gateway.state.path("gateway.log") },
          gateway: {
            port: gateway.port,
            auth: { mode: "token", token: gateway.gatewayToken },
            controlUi: { enabled: false },
            http: { endpoints: { chatCompletions: { enabled: true } } },
          },
          agents: {
            defaults: {
              workspace: gateway.state.workspaceDir,
              skipBootstrap: true,
              utilityModel: "",
              skills: [],
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef, fallbacks: [] },
              models: {
                [provider.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
            },
          },
          tools: {
            profile: "full",
            codeMode: false,
            toolSearch: false,
            exec: { security: "full", ask: "off", notifyOnExit: true },
          },
          plugins: { slots: { memory: "none" } },
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(config);
        await gateway.startGateway();
        for (const run of ["RUN_1", "RUN_2", "RUN_3"]) {
          await dispatch(`Scheduled job run. SCHEDULED_${run}_check`);
          expect(fs.existsSync(marker(run)), `${run}: ${outputs[run]}`).toBe(true);
        }
        await dispatch("Scheduled job run. SCHEDULED_BACKGROUND_check");
        expect(fs.existsSync(marker("BACKGROUND")), outputs.BACKGROUND).toBe(true);
        // The completion notice starts a turn of its own in the same session.
        await vi.waitFor(() => expect(fs.existsSync(marker("COMPLETION"))).toBe(true), {
          timeout: 60_000,
          interval: 250,
        });
        await dispatch("Scheduled job run. SCHEDULED_RUN_4_check");
        expect(fs.existsSync(marker("RUN_4")), `RUN_4: ${outputs.RUN_4}`).toBe(true);
        expect(offered).toEqual({
          RUN_1: true,
          RUN_2: true,
          RUN_3: true,
          BACKGROUND: true,
          COMPLETION: true,
          RUN_4: true,
        });
      } catch (error) {
        console.error("Synthetic provider tool outputs:", JSON.stringify(outputs));
        console.error(gateway.logs());
        throw error;
      } finally {
        await gateway.cleanup();
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
      }
    });
  },
);
