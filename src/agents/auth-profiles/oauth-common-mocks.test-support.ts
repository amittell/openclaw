/**
 * Shared mocks for auth profile OAuth tests.
 * Provides hoisted provider-runtime, CLI credential, doctor, and external CLI
 * sync mocks so OAuth tests can stay focused on store behavior.
 */
import { afterAll, vi } from "vitest";
import type { OAuthCredential } from "./types.js";

const oauthProviderRuntimeMocks = vi.hoisted(() => {
  vi.resetModules();
  return {
    refreshProviderOAuthCredentialWithPluginMock: vi.fn<
      (_params?: { context?: unknown }) => Promise<OAuthCredential | undefined>
    >(async () => undefined),
    formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
  };
});

/** Return hoisted provider-runtime OAuth mocks for per-test setup. */
export function getOAuthProviderRuntimeMocks() {
  return oauthProviderRuntimeMocks;
}

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    oauthProviderRuntimeMocks.formatProviderAuthProfileApiKeyWithPluginMock() ??
    params?.context?.access,
  resolveProviderOAuthCredentialWithPlugin: async (params: { credential: OAuthCredential }) => {
    const credential = await oauthProviderRuntimeMocks.refreshProviderOAuthCredentialWithPluginMock(
      { context: params.credential },
    );
    return credential
      ? { status: "available", credential, apiKey: credential.access }
      : { status: "unhandled" };
  },
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-cli-sync.js", () => ({
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  hasUsableOAuthCredential: (credential: OAuthCredential | undefined, now = Date.now()) =>
    credential?.type === "oauth" &&
    credential.access.trim().length > 0 &&
    Number.isFinite(credential.expires) &&
    credential.expires - now > 5 * 60 * 1000,
  readExternalCliBootstrapCredential: () => null,
  resolveExternalCliAuthProfiles: () => [],
  shouldBootstrapFromExternalCliCredential: () => false,
  shouldReplaceStoredOAuthCredential: (existing: unknown, incoming: unknown) =>
    existing !== incoming,
  // beta.3's external-auth.ts:324 reaches into this module for the fork's
  // #57137 env-token sync. A factory mock must declare every member the code
  // under test touches - vitest throws on the property ACCESS, so the `?.` at
  // that call site does not save it. Identity is the real function's no-op
  // result: the store unchanged when nothing needs syncing.
  syncEnvBackedTokenCredentials: (store: unknown) => store,
}));

afterAll(() => {
  vi.doUnmock("../cli-credentials.js");
  vi.doUnmock("../../plugins/provider-runtime.runtime.js");
  vi.doUnmock("./doctor.js");
  vi.doUnmock("./external-cli-sync.js");
  vi.resetModules();
});
