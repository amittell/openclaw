/**
 * External CLI OAuth synchronization.
 * Reads supported CLI credential stores, decides whether those credentials can
 * safely bootstrap local auth profiles, and returns runtime/persisted overlays.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { resolveRequiredOsHomeDir } from "../../infra/home-dir.js";
import { readMiniMaxCliCredentialsCached } from "../cli-credentials.js";
import { cloneAuthProfileStore } from "./clone.js";
import { EXTERNAL_CLI_SYNC_TTL_MS, MINIMAX_CLI_PROFILE_ID, authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import { isOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  areOAuthCredentialsEquivalent,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  env?: NodeJS.ProcessEnv;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

type ExternalCliSyncProvider = {
  profileId: string;
  profileAliases?: readonly string[];
  provider: string;
  aliases?: readonly string[];
  readCredentials: (
    options?: Pick<ExternalCliAuthProfileOptions, "allowKeychainPrompt" | "env">,
  ) => OAuthCredential | null;
  persistence?: ExternalCliResolvedProfile["persistence"];
};

const PERSISTED_EXTERNAL_CLI_AUTH_FLOW = "external-cli";

// External CLI bootstrap must never replace a local profile with another identity.
/** Return true when imported CLI credentials match an existing profile identity. */
function isSafeToUseExternalCliCredential(
  existing: OAuthCredential | undefined,
  imported: OAuthCredential,
): boolean {
  if (!existing) {
    return true;
  }
  if (existing.provider !== imported.provider) {
    return false;
  }
  return isSafeToCopyOAuthIdentity(existing, imported);
}

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    aliases: ["minimax", "minimax-cli"],
    readCredentials: (options) =>
      readMiniMaxCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        ...(options?.env ? { homeDir: resolveRequiredOsHomeDir(options.env) } : {}),
      }),
  },
];

function resolveExternalCliSyncProvider(params: {
  profileId: string;
  credential?: OAuthCredential;
}): ExternalCliSyncProvider | null {
  const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) =>
    externalCliProfileIdMatches(entry, params.profileId),
  );
  if (!provider) {
    return null;
  }
  if (
    params.credential &&
    !listExternalCliProviderIds(provider).includes(params.credential.provider)
  ) {
    return null;
  }
  return provider;
}

function resolveExternalCliPersistence(
  provider: ExternalCliSyncProvider,
): ExternalCliResolvedProfile["persistence"] {
  return provider.persistence ?? "persisted";
}

/** True when durable metadata assigns this stored profile to an external CLI owner. */
export function isPersistedExternalCliAuthProfile(params: {
  profileId: string;
  credential: OAuthCredential;
}): boolean {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider || resolveExternalCliPersistence(provider) !== "persisted") {
    return false;
  }
  // Historical native MiniMax logins and CLI imports share an unmarked shape.
  // Only exact CLI token backfill may assign durable external ownership.
  return params.credential.authFlow === PERSISTED_EXTERNAL_CLI_AUTH_FLOW;
}

function markPersistedExternalCliCredential(
  provider: ExternalCliSyncProvider,
  credential: OAuthCredential,
): OAuthCredential {
  return resolveExternalCliPersistence(provider) === "persisted"
    ? { ...credential, authFlow: PERSISTED_EXTERNAL_CLI_AUTH_FLOW }
    : credential;
}

function listExternalCliProfileIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.profileId, ...(providerConfig.profileAliases ?? [])];
}

function listExternalCliProviderIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.provider, ...(providerConfig.aliases ?? [])];
}

/** Provider ids whose external CLI credentials can be refreshed by this owner. */
export function listExternalCliSyncProviderIds(): string[] {
  return [...new Set(EXTERNAL_CLI_SYNC_PROVIDERS.flatMap(listExternalCliProviderIds))];
}

function normalizeExternalCliCredentialProvider(
  credential: OAuthCredential | null,
  provider: string,
): OAuthCredential | null {
  return credential ? { ...credential, provider } : null;
}

function externalCliProfileIdMatches(
  providerConfig: ExternalCliSyncProvider,
  profileId: string,
): boolean {
  return listExternalCliProfileIds(providerConfig).includes(profileId);
}

/** Read a CLI credential only for safe bootstrap of an unusable local profile. */
export function readExternalCliBootstrapCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  allowInlineOAuthTokenMaterial?: boolean;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  const imported = normalizeExternalCliCredentialProvider(
    provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
    params.credential.provider,
  );
  if (imported && isOAuthRefreshFence(params.credential)) {
    // An external snapshot has no generation ordering proof. It must not clear
    // a fence and make an older single-use refresh token replayable.
    return null;
  }
  return imported;
}

function normalizeProviderScope(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const out = new Set<string>();
  for (const value of values) {
    const raw = value.trim();
    if (!raw) {
      continue;
    }
    out.add(raw.toLowerCase());
    const normalized = normalizeProviderId(raw);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function isExternalCliProviderInScope(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { providerConfig, options, store } = params;
  const providerScope = normalizeProviderScope(options?.providerIds);
  if (providerScope === undefined && options?.profileIds === undefined) {
    return Object.entries(store.profiles).some(([profileId, existing]) => {
      return (
        externalCliProfileIdMatches(providerConfig, profileId) &&
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
      );
    });
  }
  if (
    Array.from(options?.profileIds ?? []).some((profileId) =>
      externalCliProfileIdMatches(providerConfig, profileId.trim()),
    )
  ) {
    return true;
  }
  if (!providerScope || providerScope.size === 0) {
    return false;
  }
  return listExternalCliProviderIds(providerConfig).some((alias) => {
    const raw = alias.trim().toLowerCase();
    const normalized = normalizeProviderId(alias);
    return providerScope.has(raw) || (normalized ? providerScope.has(normalized) : false);
  });
}

/** True when a previously resolved built-in CLI profile belongs to this refresh scope. */
export function isExternalCliAuthProfileInScope(params: {
  store: AuthProfileStore;
  profileId: string;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
}): boolean {
  const credential = params.store.profiles[params.profileId];
  const providerConfig = resolveExternalCliSyncProvider({
    profileId: params.profileId,
    ...(credential?.type === "oauth" ? { credential } : {}),
  });
  if (!providerConfig) {
    // A retired reader still has to release its tagged runtime overlay on refresh.
    return (
      Array.from(params.profileIds ?? []).includes(params.profileId) ||
      (credential !== undefined &&
        normalizeProviderScope(params.providerIds)?.has(
          normalizeProviderId(credential.provider),
        ) === true)
    );
  }
  return isExternalCliProviderInScope({
    providerConfig,
    store: params.store,
    options: {
      ...(params.providerIds ? { providerIds: params.providerIds } : {}),
      ...(params.profileIds ? { profileIds: params.profileIds } : {}),
    },
  });
}

function listScopedExternalCliProfileIds(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): string[] {
  const { options, providerConfig, store } = params;
  const requestedProfileIds = Array.from(options?.profileIds ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const matchingRequestedProfileIds = requestedProfileIds.filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId),
  );
  if (matchingRequestedProfileIds.length > 0) {
    return matchingRequestedProfileIds;
  }

  const existingProfileIds = Object.keys(store.profiles).filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId),
  );
  if (existingProfileIds.length > 0) {
    return existingProfileIds;
  }

  return options?.providerIds ? [providerConfig.profileId] : [];
}

function backfillExternalCliIdentity(params: {
  providerConfig: ExternalCliSyncProvider;
  existingOAuth: OAuthCredential;
  allowKeychainPrompt?: boolean;
  env?: NodeJS.ProcessEnv;
}): OAuthCredential | null {
  const creds = params.providerConfig.readCredentials({
    allowKeychainPrompt: params.allowKeychainPrompt,
    env: params.env,
  });
  // Matching token material proves the stored profile came from this CLI owner.
  // Persist that fact so refresh ownership does not depend on a later file read.
  const sameLogin = creds?.refresh === params.existingOAuth.refresh;
  if (!sameLogin) {
    return null;
  }
  const credential = markPersistedExternalCliCredential(params.providerConfig, {
    ...params.existingOAuth,
    ...(params.existingOAuth.email || !creds.email ? {} : { email: creds.email }),
  });
  return credential.authFlow === params.existingOAuth.authFlow &&
    credential.email === params.existingOAuth.email
    ? null
    : credential;
}

/**
 * Sync env-var-backed token credentials into the store.
 *
 * When `openclaw.json` declares auth profiles with `mode: "token"`, the actual
 * bearer token may live in an env var loaded from `credentials/*.env` at boot.
 * The persisted `auth-profiles.json`/SQLite entry is written once at setup and
 * goes stale when the token refreshes. The gateway main session (WebSocket
 * path) keeps live in-memory auth, but isolated embedded runs read the store
 * from disk, so a stale token makes every LLM request fail across all
 * profiles until the session is aborted. This sync resolves the env var and
 * returns a store clone with the fresh token so the caller can persist it.
 *
 * Env var naming convention: the profile id upper-cased with every character
 * outside `[A-Z0-9_]` replaced by `_`, suffixed with `_TOKEN` (e.g.
 * `anthropic:me.com` -> `ANTHROPIC_ME_COM_TOKEN`, `anthropic:work-acct` ->
 * `ANTHROPIC_WORK_ACCT_TOKEN`), so every profile id maps to a name a shell can
 * set. The earlier rule replaced only `:` and `.`; its name is still read as a
 * fallback so an environment set under it keeps syncing. Profiles whose token is backed by a secret ref
 * (explicit `tokenRef` or `${ENV}` template) are resolved by the credential
 * pipeline and are never touched here.
 */
export function syncEnvBackedTokenCredentials(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions & { env?: NodeJS.ProcessEnv },
): AuthProfileStore | null {
  const env = options?.env ?? process.env;
  let next: AuthProfileStore | undefined;
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (credential.type !== "token") {
      continue;
    }
    if (coerceSecretRef(credential.tokenRef) || coerceSecretRef(credential.token)) {
      continue;
    }
    const upperId = profileId.toUpperCase();
    const portableEnvVarName = upperId.replace(/[^A-Z0-9_]/g, "_") + "_TOKEN";
    const legacyEnvVarName = upperId.replace(/[:.]/g, "_") + "_TOKEN";
    const envVarName =
      env[portableEnvVarName] === undefined && env[legacyEnvVarName] !== undefined
        ? legacyEnvVarName
        : portableEnvVarName;
    const envValue = env[envVarName]?.trim();
    if (!envValue || credential.token === envValue) {
      continue;
    }
    next ??= cloneAuthProfileStore(store);
    next.profiles[profileId] = { ...credential, token: envValue };
    authProfilesLog.info(`synced token credential from env var ${envVarName}`, {
      profileId,
    });
  }
  return next ?? null;
}

/** Resolve scoped external CLI auth profiles available to overlay or persist. */
export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions,
): ExternalCliResolvedProfile[] {
  const profiles: ExternalCliResolvedProfile[] = [];
  const now = Date.now();
  for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
    if (!isExternalCliProviderInScope({ providerConfig, store, options })) {
      continue;
    }
    const scopedProfileIds = listScopedExternalCliProfileIds({
      providerConfig,
      store,
      options,
    });
    for (const profileId of scopedProfileIds) {
      const existing = store.profiles[profileId];
      const existingOAuth =
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
          ? existing
          : undefined;
      if (existing && !existingOAuth) {
        authProfilesLog.debug("kept explicit local auth over external cli bootstrap", {
          profileId,
          provider: providerConfig.provider,
          localType: existing.type,
          localProvider: existing.provider,
        });
        continue;
      }
      if (existingOAuth && hasUsableOAuthCredential(existingOAuth, { now })) {
        // Profiles synced before identity capture carry no email; backfill the
        // non-secret metadata once the CLI read proves it is the same login.
        const backfilled = backfillExternalCliIdentity({
          providerConfig,
          existingOAuth,
          allowKeychainPrompt: options?.allowKeychainPrompt,
          env: options?.env,
        });
        if (backfilled) {
          profiles.push({
            profileId,
            credential: backfilled,
            persistence: resolveExternalCliPersistence(providerConfig),
          });
        }
        continue;
      }
      const creds = normalizeExternalCliCredentialProvider(
        providerConfig.readCredentials({
          allowKeychainPrompt: options?.allowKeychainPrompt,
          env: options?.env,
        }),
        existingOAuth?.provider ?? providerConfig.provider,
      );
      if (!creds) {
        continue;
      }
      if (existingOAuth && isOAuthRefreshFence(existingOAuth)) {
        authProfilesLog.warn("refused unordered external cli oauth recovery for a fenced profile", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
        authProfilesLog.warn("refused external cli oauth bootstrap: identity mismatch", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        existingOAuth &&
        !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) &&
        !areOAuthCredentialsEquivalent(existingOAuth, creds)
      ) {
        authProfilesLog.warn(
          "refused external cli oauth bootstrap: identity mismatch or missing binding",
          {
            profileId,
            provider: providerConfig.provider,
          },
        );
        continue;
      }
      if (
        !shouldBootstrapFromExternalCliCredential({
          existing: existingOAuth,
          imported: creds,
          now,
        })
      ) {
        if (existingOAuth) {
          authProfilesLog.debug("kept usable local oauth over external cli bootstrap", {
            profileId,
            provider: providerConfig.provider,
            localExpires: existingOAuth.expires,
            externalExpires: creds.expires,
          });
        }
        continue;
      }
      authProfilesLog.debug(
        "used external cli oauth bootstrap because local oauth was missing or unusable",
        {
          profileId,
          provider: providerConfig.provider,
          localExpires: existingOAuth?.expires,
          externalExpires: creds.expires,
        },
      );
      profiles.push({
        profileId,
        credential: markPersistedExternalCliCredential(providerConfig, creds),
        persistence: resolveExternalCliPersistence(providerConfig),
      });
    }
  }
  return profiles;
}
