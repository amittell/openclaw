import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexModelListResponse, CodexTurnCompletedNotification } from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_AUTH === "1";
const describeLive = LIVE ? describe : describe.skip;

type CodexAuthFile = {
  tokens?: { access_token?: string; account_id?: string };
};

describeLive("Codex app-server real auth refresh boundary", () => {
  it("recovers a real provider turn through OpenClaw's refresh handler", async () => {
    const auth = JSON.parse(
      await fs.readFile(path.join(os.homedir(), ".codex", "auth.json"), "utf8"),
    ) as CodexAuthFile;
    const accessToken = auth.tokens?.access_token?.trim();
    const accountId = auth.tokens?.account_id?.trim();
    if (!accessToken || !accountId) {
      throw new Error("A current Codex ChatGPT login is required for this live proof.");
    }
    const invalidAccessToken = `${accessToken.slice(0, -1)}${accessToken.endsWith("A") ? "B" : "A"}`;

    await withTempDir("openclaw-codex-auth-refresh-live-", async (root) => {
      const profileId = "openai:boundary-proof";
      const store = {
        version: 1 as const,
        profiles: {
          [profileId]: {
            type: "token" as const,
            provider: "openai",
            token: invalidAccessToken,
            accountId,
          },
        },
      };
      const runtime = resolveCodexAppServerRuntimeOptions({
        pluginConfig: { appServer: { homeScope: "local" } },
        env: {},
      });
      const workspace = path.join(root, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      let refreshRequests = 0;
      const client = await createIsolatedCodexAppServerClient({
        startOptions: {
          ...runtime.start,
          clearEnv: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
        },
        agentDir: path.join(root, "agent"),
        authProfileId: profileId,
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
        // The app-server has the invalid token already. Only the installed
        // OpenClaw server-request handler can observe this replacement.
        store.profiles[profileId].token = accessToken;

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
            input: [{ type: "text", text: "Reply with exactly LIVE_REFRESH_OK." }],
          },
          { timeoutMs: 120_000 },
        );
        const result = await Promise.race([
          completed,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("live refresh turn timed out")), 180_000).unref();
          }),
        ]);
        expect(result.turn.status, JSON.stringify(result.turn.error)).toBe("completed");
        expect(JSON.stringify(result.turn.items)).toContain("LIVE_REFRESH_OK");
        expect(refreshRequests).toBe(1);
      } finally {
        await client.closeAndWait();
      }
    });
  }, 300_000);
});
