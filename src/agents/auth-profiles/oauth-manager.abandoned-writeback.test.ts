/**
 * Regression: an in-lock OAuth critical section abandoned by its caller
 * deadline must retain the global refresh lock until provider work settles.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { testing as externalAuthTesting } from "./external-auth.test-support.js";
import { createOAuthManager, OAuthManagerRefreshError } from "./oauth-manager.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "./store.js";
import type { OAuthCredential, OAuthCredentials } from "./types.js";

// Shrink the in-lock deadline so a real-timer test can observe an abandoned
// critical section. The call deadline stays larger so the section deadline is
// what abandons the caller while the provider operation remains in flight.
vi.mock("./constants.js", async () => {
  const actual = await vi.importActual<typeof import("./constants.js")>("./constants.js");
  return {
    ...actual,
    OAUTH_REFRESH_INLOCK_TIMEOUT_MS: 150,
    OAUTH_REFRESH_CALL_TIMEOUT_MS: 5_000,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function withOAuthAgentDirs(
  prefix: string,
  run: (dirs: { mainAgentDir: string; agentDir: string }) => Promise<void>,
): Promise<void> {
  const tempRoot = tempDirs.make(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: tempRoot }, async () => {
    const mainAgentDir = path.join(tempRoot, "agents", "main", "agent");
    const agentDir = path.join(tempRoot, "agents", "sub", "agent");
    await withEnvAsync({ OPENCLAW_AGENT_DIR: mainAgentDir }, async () => {
      await fs.mkdir(agentDir, { recursive: true });
      await fs.mkdir(mainAgentDir, { recursive: true });
      await run({ mainAgentDir, agentDir });
    });
  });
}

beforeEach(() => {
  externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  clearRuntimeAuthProfileStoreSnapshots();
});

afterEach(() => {
  externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  clearRuntimeAuthProfileStoreSnapshots();
});

describe("abandoned in-lock OAuth refresh write-back", () => {
  it("retains refresh ownership until an abandoned provider call settles", async () => {
    await withOAuthAgentDirs("oauth-manager-abandoned-writeback-", async ({ agentDir }) => {
      const profileId = "openai:oauth";
      const staleCredential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access: "expired-access",
        refresh: "expired-refresh",
        expires: Date.now() - 60_000,
      };
      saveAuthProfileStore({ version: 1, profiles: { [profileId]: staleCredential } }, agentDir, {
        filterExternalAuthProfiles: false,
      });

      // The refresh call outlives the (shrunken) in-lock deadline, then
      // completes with rotated tokens only after the section was abandoned.
      let resolveRefresh: ((value: OAuthCredentials) => void) | undefined;
      const refreshCredential = vi
        .fn<(credential: OAuthCredential) => Promise<OAuthCredentials>>()
        .mockImplementationOnce(
          () =>
            new Promise<OAuthCredentials>((resolve) => {
              resolveRefresh = resolve;
            }),
        )
        .mockImplementationOnce(async (credential) => {
          expect(credential.refresh).toBe("expired-refresh");
          return {
            access: "successor-access",
            refresh: "successor-refresh",
            expires: Date.now() + 60_000,
          };
        });
      const manager = createOAuthManager({
        buildApiKey: async (_provider, credential) => credential.access,
        refreshCredential,
        readBootstrapCredential: () => null,
        isRefreshTokenReusedError: () => false,
      });

      await expect(
        manager.resolveOAuthAccess({
          store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          }),
          profileId,
          credential: staleCredential,
          agentDir,
        }),
      ).rejects.toBeInstanceOf(OAuthManagerRefreshError);
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      const successor = manager.resolveOAuthAccess({
        store: ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        }),
        profileId,
        credential: staleCredential,
        agentDir,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      // The successor may enter the in-process queue, but it must not reach the
      // rotating-token provider while the abandoned call still owns the lock.
      expect(refreshCredential).toHaveBeenCalledTimes(1);

      // Let the abandoned continuation settle. Its tokens are discarded, the
      // lock releases, and only then may the successor rotate the stored token.
      resolveRefresh?.({
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      });
      await expect(successor).resolves.toMatchObject({
        apiKey: "successor-access",
        credential: {
          access: "successor-access",
          refresh: "successor-refresh",
        },
      });
      expect(refreshCredential).toHaveBeenCalledTimes(2);

      clearRuntimeAuthProfileStoreSnapshots();
      const subStore = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
      expect(subStore.profiles[profileId]).toMatchObject({
        access: "successor-access",
        refresh: "successor-refresh",
      });
      const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
        allowKeychainPrompt: false,
      });
      expect(mainStore.profiles[profileId]).toMatchObject({
        access: "successor-access",
        refresh: "successor-refresh",
      });
    });
  });
});
