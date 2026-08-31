/**
 * Env-var-backed token credential sync tests.
 * Covers the profile-id → env-var naming convention, skip conditions,
 * secret-ref protection, and the persisted-store write-back path used by
 * isolated embedded runs (discoverAuthStorage) after a token refresh.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { syncPersistedExternalCliAuthProfiles } from "./auth-profiles/external-auth.js";
import { syncEnvBackedTokenCredentials } from "./auth-profiles/external-cli-sync.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store.js";
import type { AuthProfileStore, TokenCredential } from "./auth-profiles/types.js";

const ENV_KEY = "ANTHROPIC_ME_COM_TOKEN";
const PROFILE_ID = "anthropic:me.com";

function tokenStore(token: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [PROFILE_ID]: { type: "token", provider: "anthropic", token } as TokenCredential,
    },
  };
}

describe("syncEnvBackedTokenCredentials", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("syncs the token from the env var into the matching store entry", () => {
    const next = syncEnvBackedTokenCredentials(tokenStore("stale-token"), {
      env: { [ENV_KEY]: "fresh-token" },
    });
    expect(next).not.toBeNull();
    expect((next?.profiles?.[PROFILE_ID] as TokenCredential | undefined)?.token).toBe(
      "fresh-token",
    );
    // Original store is not mutated in place.
    expect((tokenStore("stale-token").profiles[PROFILE_ID] as TokenCredential).token).toBe(
      "stale-token",
    );
  });

  it("skips sync when the env var matches the stored token", () => {
    const store = tokenStore("same-token");
    const next = syncEnvBackedTokenCredentials(store, { env: { [ENV_KEY]: "same-token" } });
    expect(next).toBeNull();
  });

  it("skips sync when the env var is not set", () => {
    const store = tokenStore("existing-token");
    expect(syncEnvBackedTokenCredentials(store, { env: {} })).toBeNull();
  });

  it("trims whitespace around the env value", () => {
    const next = syncEnvBackedTokenCredentials(tokenStore("stale"), {
      env: { [ENV_KEY]: "  padded-token " },
    });
    expect((next?.profiles?.[PROFILE_ID] as TokenCredential | undefined)?.token).toBe(
      "padded-token",
    );
  });

  it("does not touch non-token profile types", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:codex": {
          type: "oauth",
          provider: "openai",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      },
    };
    expect(
      syncEnvBackedTokenCredentials(store, {
        env: { OPENAI_CODEX_TOKEN: "should-not-apply" },
      }),
    ).toBeNull();
  });

  it("does not touch token profiles backed by a secret ref", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [PROFILE_ID]: {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "env", id: "OTHER_ENV" },
        } as TokenCredential,
      },
    };
    expect(syncEnvBackedTokenCredentials(store, { env: { [ENV_KEY]: "fresh" } })).toBeNull();
  });

  it("does not touch token profiles with a ${ENV} template token", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [PROFILE_ID]: {
          type: "token",
          provider: "anthropic",
          token: "${OTHER_ENV}",
        } as TokenCredential,
      },
    };
    expect(syncEnvBackedTokenCredentials(store, { env: { [ENV_KEY]: "fresh" } })).toBeNull();
  });
});

describe("syncPersistedExternalCliAuthProfiles env-token composition", () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it("applies env-token sync even when no external CLI profiles are candidates", () => {
    const next = syncPersistedExternalCliAuthProfiles(tokenStore("stale"), {
      env: { [ENV_KEY]: "fresh" },
    });
    expect((next.profiles[PROFILE_ID] as TokenCredential).token).toBe("fresh");
  });

  it("returns the same store reference when nothing changed", () => {
    const store = tokenStore("stable");
    expect(syncPersistedExternalCliAuthProfiles(store, { env: {} })).toBe(store);
  });
});

describe("ensureAuthProfileStore env-token persistence", () => {
  const mocks = vi.hoisted(() => ({
    resolveExternalAuthProfilesWithPlugins: vi.fn(() => []),
  }));

  vi.mock("../plugins/provider-runtime.js", () => ({
    resolveExternalAuthProfilesWithPlugins: mocks.resolveExternalAuthProfilesWithPlugins,
  }));

  async function withAgentDirEnv(prefix: string, run: (agentDir: string) => void | Promise<void>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const agentDir = path.join(root, "agents", "main", "agent");
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: root, OPENCLAW_AGENT_DIR: agentDir },
        async () => await run(agentDir),
      );
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it("patches the persisted token from env on load and writes it back to the store", async () => {
    await withAgentDirEnv("openclaw-auth-env-token-", async (agentDir) => {
      saveAuthProfileStore(tokenStore("stale-persisted-token"), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();

      await withEnvAsync({ [ENV_KEY]: "fresh-persisted-token" }, async () => {
        const loaded = ensureAuthProfileStore(agentDir);
        expect((loaded.profiles[PROFILE_ID] as TokenCredential).token).toBe(
          "fresh-persisted-token",
        );
      });

      // Env var cleared: the patched token must now come from the persisted
      // store itself, proving the sync wrote it back on load.
      clearRuntimeAuthProfileStoreSnapshots();
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect((persisted?.profiles?.[PROFILE_ID] as TokenCredential | undefined)?.token).toBe(
        "fresh-persisted-token",
      );
    });
  });

  it("leaves the persisted token untouched when the env var is unset", async () => {
    await withAgentDirEnv("openclaw-auth-env-token-unset-", (agentDir) => {
      saveAuthProfileStore(tokenStore("original-token"), agentDir);
      clearRuntimeAuthProfileStoreSnapshots();

      const loaded = ensureAuthProfileStore(agentDir);
      expect((loaded.profiles[PROFILE_ID] as TokenCredential).token).toBe("original-token");
      clearRuntimeAuthProfileStoreSnapshots();

      const reloaded = ensureAuthProfileStore(agentDir);
      expect((reloaded.profiles[PROFILE_ID] as TokenCredential).token).toBe("original-token");
    });
  });
});
