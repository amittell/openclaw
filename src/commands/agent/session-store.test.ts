import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateSessionStoreAfterAgentRun } from "../../agents/command/session-store.js";
import { resolveSession } from "../../agents/command/session.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:acp:${randomUUID()}`;
    const sessionId = randomUUID();

    const existing: SessionEntry = {
      sessionId,
      updatedAt: Date.now(),
      acp: acpMeta(),
    };
    await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

    const staleInMemory: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore: staleInMemory,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.acp).toBeDefined();
    expect(staleInMemory[sessionKey]?.acp).toBeDefined();
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:codex:report:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    const report = {
      source: "run" as const,
      generatedAt: Date.now(),
      bootstrapTruncation: {
        warningMode: "once" as const,
        warningSignaturesSeen: ["sig-a", "sig-b"],
      },
      systemPrompt: {
        chars: 1,
        projectContextChars: 1,
        nonProjectContextChars: 0,
      },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
      result: {
        payloads: [],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
          },
          systemPromptReport: report,
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
      "sig-a",
      "sig-b",
    ]);
    expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
      "once",
    );
  });

  it("does not persist fallback model into session store and keeps primary context tokens", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:test:fallback:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        model: "gpt-5.3",
        modelProvider: "openai",
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3",
      fallbackProvider: "anthropic",
      fallbackModel: "claude-sonnet-4-20250514",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            usage: { input: 100, output: 50 },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    const expectedPrimaryContextTokens =
      resolveContextTokensForModel({
        cfg: {} as never,
        provider: "openai",
        model: "gpt-5.3",
        fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
        allowAsyncLoad: false,
      }) ?? DEFAULT_CONTEXT_TOKENS;
    expect(persisted?.model).toBe("gpt-5.3");
    expect(persisted?.modelProvider).toBe("openai");
    expect(persisted?.contextTokens).toBe(expectedPrimaryContextTokens);
  });

  it("persists hook-overridden model even when it differs from configured defaults", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:test:hook-override:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    await updateSessionStoreAfterAgentRun({
      cfg: {} as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "anthropic",
            model: "claude-opus-4-5",
            isHookOverride: true,
            usage: { input: 100, output: 50 },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    expect(persisted?.model).toBe("claude-opus-4-5");
    expect(persisted?.modelProvider).toBe("anthropic");
  });

  it("does not persist fallback CLI session resume handles", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = `agent:test:fallback-cli:${randomUUID()}`;
    const sessionId = randomUUID();

    const sessionStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

    await updateSessionStoreAfterAgentRun({
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {},
            },
          },
        },
      } as never,
      sessionId,
      sessionKey,
      storePath,
      sessionStore,
      defaultProvider: "openai",
      defaultModel: "gpt-5.3",
      result: {
        payloads: [],
        meta: {
          aborted: false,
          agentMeta: {
            provider: "claude-cli",
            model: "claude-opus-4-5",
            sessionId: "fallback-cli-session-id",
            cliSessionBinding: {
              sessionId: "fallback-cli-session-id",
              authEpoch: "fallback-auth-epoch",
            },
            usage: { input: 100, output: 50 },
          },
        },
      } as never,
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
    const persistedStr = JSON.stringify(persisted ?? {});
    expect(persistedStr).not.toContain("fallback-cli-session-id");
    expect(persistedStr).not.toContain("fallback-auth-epoch");
  });

  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const cfg = {
      session: {
        store: storePath,
        mainKey: "main",
      },
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {},
          },
        },
      },
    } as never;

    const first = resolveSession({
      cfg,
      sessionId: "explicit-session-123",
    });

    expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

    await updateSessionStoreAfterAgentRun({
      cfg,
      sessionId: first.sessionId,
      sessionKey: first.sessionKey!,
      storePath: first.storePath,
      sessionStore: first.sessionStore!,
      defaultProvider: "claude-cli",
      defaultModel: "claude-sonnet-4-6",
      result: {
        payloads: [],
        meta: {
          agentMeta: {
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            sessionId: "claude-cli-session-1",
            cliSessionBinding: {
              sessionId: "claude-cli-session-1",
              authEpoch: "auth-epoch-1",
            },
          },
        },
      } as never,
    });

    const second = resolveSession({
      cfg,
      sessionId: "explicit-session-123",
    });

    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second.sessionEntry?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "claude-cli-session-1",
      authEpoch: "auth-epoch-1",
    });

    const persisted = loadSessionStore(storePath, { skipCache: true })[first.sessionKey!];
    expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
      sessionId: "claude-cli-session-1",
      authEpoch: "auth-epoch-1",
    });
  });
});
