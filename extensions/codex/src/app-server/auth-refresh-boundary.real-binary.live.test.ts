import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { loadAuthProfileStoreForSecretsRuntime } from "openclaw/plugin-sdk/agent-runtime";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { isCodexCliOAuthRuntimeProfile } from "openclaw/plugin-sdk/provider-auth-runtime";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type {
  CodexErrorNotification,
  CodexModelListResponse,
  CodexTurnCompletedNotification,
} from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

// Real bundled Codex app-server binary with synthetic credentials only. The
// native Codex login is a synthetic CODEX_HOME/auth.json, the ChatGPT backend
// is a loopback fake, and the token exchange is an in-process provider
// refresh hook. Nothing reads ~/.codex or contacts OpenAI.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_AUTH === "1";
const describeLive = LIVE ? describe : describe.skip;

const PROFILE_ID = "openai:default";
const ACCOUNT_ID = "acct-synthetic-boundary";
const OTHER_ACCOUNT_ID = "acct-synthetic-reassigned";
const MARKER = "LIVE_REFRESH_OK";

type Bearer = "stale" | "fresh" | "other" | "none";
type BackendRequest = { method: string; path: string; bearer: Bearer };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function syntheticAccessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
    nonce: randomBytes(8).toString("hex"),
  };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.synthetic`;
}

async function writeNativeCodexAuth(file: string, tokens: Record<string, string>): Promise<void> {
  const record = { auth_mode: "chatgpt", tokens, last_refresh: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
}

function sseCompletion(): string {
  const events = [
    { type: "response.created", response: { id: "resp_boundary" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg_boundary",
        content: [{ type: "output_text", text: MARKER }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_boundary",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function startLoopbackBackend(params: {
  stale: string;
  fresh: string;
  onFirstStaleTurn?: () => Promise<void>;
}) {
  const requests: BackendRequest[] = [];
  let staleTurnSeen = false;
  const classify = (header: string | undefined): Bearer => {
    const bearer = header?.replace(/^Bearer /, "");
    if (!bearer) {
      return "none";
    }
    return bearer === params.stale ? "stale" : bearer === params.fresh ? "fresh" : "other";
  };
  const server = http.createServer((req, res) => {
    const entry = {
      method: req.method ?? "",
      path: (req.url ?? "").split("?")[0] ?? "",
      bearer: classify(req.headers.authorization),
    };
    requests.push(entry);
    req.resume();
    req.on("end", async () => {
      if (req.method !== "POST" || !entry.path.endsWith("/responses")) {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (entry.bearer === "fresh") {
        res.writeHead(200, { "content-type": "text/event-stream" }).end(sseCompletion());
        return;
      }
      if (!staleTurnSeen) {
        staleTurnSeen = true;
        await params.onFirstStaleTurn?.();
      }
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "token_expired", message: "synthetic stale" } }));
    });
  });
  // Codex tries the Responses WebSocket first; decline it so SSE carries the turn.
  server.on("upgrade", (req, socket) => {
    const upgradePath = (req.url ?? "").split("?")[0] ?? "";
    requests.push({
      method: "UPGRADE",
      path: upgradePath,
      bearer: classify(req.headers.authorization),
    });
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function runNativeCodexRefreshTurn(params: {
  root: string;
  reassignNativeLoginBeforeRefresh?: boolean;
}) {
  const { root } = params;
  const nativeCodexHome = path.join(root, "native-codex");
  const nativeAuthPath = path.join(nativeCodexHome, "auth.json");
  const staleAccess = syntheticAccessToken(ACCOUNT_ID);
  const freshAccess = syntheticAccessToken(ACCOUNT_ID);
  const nativeRefresh = `synthetic-native-refresh-${randomBytes(8).toString("hex")}`;
  const rotatedRefresh = `synthetic-rotated-refresh-${randomBytes(8).toString("hex")}`;
  await fs.mkdir(nativeCodexHome, { recursive: true });
  await writeNativeCodexAuth(nativeAuthPath, {
    access_token: staleAccess,
    refresh_token: nativeRefresh,
    account_id: ACCOUNT_ID,
  });
  const backend = await startLoopbackBackend({
    stale: staleAccess,
    fresh: freshAccess,
    // Simulate `codex login` into another ChatGPT account after the app-server
    // started with the first login and before it asks OpenClaw to refresh.
    onFirstStaleTurn: params.reassignNativeLoginBeforeRefresh
      ? () =>
          writeNativeCodexAuth(nativeAuthPath, {
            access_token: syntheticAccessToken(OTHER_ACCOUNT_ID),
            refresh_token: `synthetic-other-refresh-${randomBytes(8).toString("hex")}`,
            account_id: OTHER_ACCOUNT_ID,
          })
      : undefined,
  });
  const stateDir = path.join(root, "state");
  try {
    return await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, CODEX_HOME: nativeCodexHome },
      async () => {
        const agentDir = path.join(root, "agent");
        await fs.mkdir(agentDir, { recursive: true });
        const rowBefore = loadAuthProfileStoreForSecretsRuntime().profiles[PROFILE_ID];
        const store = loadAuthProfileStoreForSecretsRuntime(agentDir, {
          externalCliProviderIds: ["openai"],
        });
        const overlaid = store.profiles[PROFILE_ID];
        const nativeOverlayBefore = overlaid?.type === "oauth" && overlaid.access === staleAccess;
        const nativeProvenanceBefore = isCodexCliOAuthRuntimeProfile({
          store,
          profileId: PROFILE_ID,
        });
        const nativeAuthBeforeTurn = sha256(await fs.readFile(nativeAuthPath, "utf8"));

        const hookCalls: Array<{ access: boolean; refresh: boolean; lockHeld: boolean }> = [];
        const registry = createEmptyPluginRegistry();
        registry.providers.push({
          pluginId: "openai-live-boundary",
          source: "live-test",
          provider: {
            id: "openai",
            label: "OpenAI live auth boundary",
            auth: [],
            // Token-endpoint stand-in. It records what it was asked to rotate.
            refreshOAuth: async (credential) => {
              const lockEntries = await fs.readdir(path.join(stateDir, "locks", "oauth-refresh"));
              hookCalls.push({
                access: credential.access === staleAccess,
                refresh: credential.refresh === nativeRefresh,
                lockHeld: lockEntries.some((entry) => entry.endsWith(".lock")),
              });
              return {
                ...credential,
                access: freshAccess,
                refresh: rotatedRefresh,
                expires: Date.now() + 60 * 60_000,
              };
            },
          },
        });
        setActivePluginRegistry(registry, "codex-auth-boundary-live");
        let refreshRequests = 0;
        const turnErrors: string[] = [];
        let turn: CodexTurnCompletedNotification["turn"] | undefined;
        try {
          const runtime = resolveCodexAppServerRuntimeOptions({
            pluginConfig: { appServer: { homeScope: "local" } },
            env: process.env,
          });
          const workspace = path.join(root, "workspace");
          await fs.mkdir(workspace, { recursive: true });
          const client = await createIsolatedCodexAppServerClient({
            startOptions: {
              ...runtime.start,
              args: [
                ...runtime.start.args,
                "-c",
                `openai_base_url="${backend.baseUrl}/backend-api/codex"`,
                "-c",
                `chatgpt_base_url="${backend.baseUrl}/backend-api/"`,
              ],
              clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
            },
            agentDir,
            authProfileId: PROFILE_ID,
            authProfileStore: store,
            authRequirement: "subscription",
            timeoutMs: 120_000,
            onStartedClient: (startedClient) => {
              startedClient.addRequestHandler((request) => {
                if (request.method === "account/chatgptAuthTokens/refresh") {
                  refreshRequests += 1;
                }
                return undefined;
              });
            },
          });
          try {
            const listed = await client.request<CodexModelListResponse>(
              "model/list",
              { limit: 100, cursor: null, includeHidden: false },
              { timeoutMs: 60_000 },
            );
            const modelId =
              listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
            if (!modelId) {
              throw new Error("Codex model/list returned no models");
            }
            let complete!: (value: CodexTurnCompletedNotification) => void;
            const completed = new Promise<CodexTurnCompletedNotification>((resolve) => {
              complete = resolve;
            });
            client.addNotificationHandler((notification) => {
              if (notification.method === "turn/completed") {
                complete(notification.params as CodexTurnCompletedNotification);
              }
              if (notification.method === "error") {
                turnErrors.push(
                  (notification.params as CodexErrorNotification).error.message ?? "",
                );
              }
            });
            const started = await client.request(
              "thread/start",
              {
                model: modelId,
                cwd: workspace,
                approvalPolicy: "never",
                sandbox: "read-only",
                threadSource: "user",
              },
              { timeoutMs: 120_000 },
            );
            await client.request(
              "turn/start",
              {
                threadId: started.thread.id,
                input: [{ type: "text", text: `Reply with exactly ${MARKER}.` }],
              },
              { timeoutMs: 120_000 },
            );
            turn = (
              await Promise.race([
                completed,
                new Promise<never>((_, reject) => {
                  setTimeout(() => reject(new Error("refresh turn timed out")), 180_000).unref();
                }),
              ])
            ).turn;
          } finally {
            await client.closeAndWait();
          }
        } finally {
          resetPluginRuntimeStateForTest();
        }
        const row = loadAuthProfileStoreForSecretsRuntime();
        const promoted = row.profiles[PROFILE_ID];
        const observation = {
          rowBefore: rowBefore !== undefined,
          nativeOverlayBefore,
          nativeProvenanceBefore,
          turnStatus: turn?.status,
          markerSeen: JSON.stringify(turn?.items ?? []).includes(MARKER),
          refreshRequests,
          turnErrors: [...new Set(turnErrors)],
          hookCalls,
          responsesBearers: backend.requests
            .filter((entry) => entry.method === "POST" && entry.path.endsWith("/responses"))
            .map((entry) => entry.bearer),
          anyOtherBearer: backend.requests.some((entry) => entry.bearer === "other"),
          promotedRow: promoted?.type === "oauth",
          promotedAccess: promoted?.type === "oauth" && promoted.access === freshAccess,
          promotedRefresh: promoted?.type === "oauth" && promoted.refresh === rotatedRefresh,
          promotedPersisted: row.runtimePersistedProfileIds?.includes(PROFILE_ID) === true,
          nativeAuthUnchanged:
            sha256(await fs.readFile(nativeAuthPath, "utf8")) === nativeAuthBeforeTurn,
        };
        console.log(`[boundary] ${JSON.stringify(observation)}`);
        return observation;
      },
    );
  } finally {
    await backend.close();
  }
}

describeLive("Codex app-server real auth refresh boundary", () => {
  it("promotes the first native Codex rotation through OpenClaw's refresh owner", async () => {
    await withTempDir("openclaw-codex-auth-refresh-live-", async (root) => {
      const seen = await runNativeCodexRefreshTurn({ root });
      // Entry preconditions for the native branch: no SQLite row, only the
      // openai:default runtime overlay carrying external-CLI provenance.
      expect(seen.rowBefore).toBe(false);
      expect(seen.nativeOverlayBefore).toBe(true);
      expect(seen.nativeProvenanceBefore).toBe(true);
      // Branch fingerprint: the rotated grant became the canonical main SQLite
      // row. No other refresh path can create a row that did not exist.
      expect(seen.promotedRow).toBe(true);
      expect(seen.promotedAccess).toBe(true);
      expect(seen.promotedRefresh).toBe(true);
      expect(seen.promotedPersisted).toBe(true);
      // The token exchange ran once, under the lock, on the native grant.
      expect(seen.hookCalls).toEqual([{ access: true, refresh: true, lockHeld: true }]);
      expect(seen.refreshRequests).toBe(1);
      expect(seen.responsesBearers.at(0)).toBe("stale");
      expect(seen.responsesBearers.at(-1)).toBe("fresh");
      expect(seen.anyOtherBearer).toBe(false);
      expect(seen.turnStatus).toBe("completed");
      expect(seen.markerSeen).toBe(true);
      // Native Codex state stays read-only.
      expect(seen.nativeAuthUnchanged).toBe(true);
    });
  }, 300_000);

  it("refuses a native login reassigned to another account before refresh", async () => {
    await withTempDir("openclaw-codex-auth-refresh-live-", async (root) => {
      const seen = await runNativeCodexRefreshTurn({
        root,
        reassignNativeLoginBeforeRefresh: true,
      });
      expect(seen.nativeProvenanceBefore).toBe(true);
      // The native reread returns the other account's login unpromoted; the
      // bridge's account-continuity check refuses it on every refresh request.
      expect(
        seen.turnErrors.some((message) =>
          /ChatGPT workspace changed (before|during) Codex token refresh/.test(message),
        ),
      ).toBe(true);
      expect(seen.promotedRow).toBe(false);
      expect(seen.hookCalls).toEqual([]);
      expect(seen.anyOtherBearer).toBe(false);
      expect(seen.responsesBearers).not.toContain("fresh");
      expect(seen.turnStatus).toBe("failed");
      expect(seen.markerSeen).toBe(false);
    });
  }, 300_000);
});
