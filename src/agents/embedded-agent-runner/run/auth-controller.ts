/**
 * Coordinates provider auth, profile rotation, and runtime auth refresh.
 */
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { Model } from "../../../llm/types.js";
import type { ProviderModelRouteAuthRequirement } from "../../../plugin-sdk/provider-model-types.js";
import { prepareProviderRuntimeAuth } from "../../../plugins/provider-runtime.js";
import { SecretSurfaceUnavailableError } from "../../../secrets/runtime-degraded-state.js";
import {
  type AuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  resolveProfilesUnavailableReason,
  resolveSubscriptionAuthModeForProfiles,
} from "../../auth-profiles.js";
import { OAuthRefreshFailureError } from "../../auth-profiles/oauth-refresh-failure.js";
import {
  classifyFailoverReason,
  isFailoverErrorMessage,
  type FailoverReason,
} from "../../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import { getFailoverErrorCode } from "../../failover/error.js";
import { renderAuthProfileFailoverCopy } from "../../failover/user-copy.js";
import {
  getApiKeyForModelCore,
  MissingProviderAuthError,
  type ResolvedProviderAuth,
} from "../../model-auth.js";
import { buildProviderAuthRecoveryHint } from "../../provider-auth-recovery-hint.js";
import { providerModelRouteAcceptsAuthMode } from "../../provider-model-route-auth.js";
import {
  applyPreparedRuntimeAuthToModel,
  type ModelProviderRequestTransportOverrides,
} from "../../provider-request-config.js";
import { protectPreparedProviderRuntimeAuth } from "../../provider-runtime-auth-protection.js";
import { unwrapSecretSentinelsForProviderEgress } from "../../provider-secret-egress.js";
import {
  clampRuntimeAuthRefreshDelayMs,
  RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS,
  RuntimeAuthDeadlineError,
  withRuntimeAuthRefreshDeadline,
} from "../../runtime-auth-refresh.js";
import { resolveEmbeddedAuthCooldownProbePolicy } from "./auth-controller.cooldown-probe.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { AuthProfileFailurePolicy } from "./auth-profile-failure-policy.types.js";
import {
  RUNTIME_AUTH_REFRESH_MARGIN_MS,
  RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
  RUNTIME_AUTH_REFRESH_RETRY_MS,
  type RuntimeAuthState,
} from "./helpers.js";
import type { resolveEmbeddedRunEffectiveModel } from "./model-harness.js";
import type { RunEmbeddedAgentParams } from "./params.js";
// Re-exported so `./auth-controller.js` stays the import path for the cooldown
// probe policy; runtime-preparation.ts and the e2e module mock both read it there.
export { resolveEmbeddedAuthCooldownProbePolicy } from "./auth-controller.cooldown-probe.js";

export type EmbeddedRunAuthState = {
  readonly models: {
    runtime: Model;
    effective: ReturnType<typeof resolveEmbeddedRunEffectiveModel>["effectiveModel"];
  };
  apiKeyInfo: ResolvedProviderAuth | null;
  lastProfileId: string | undefined;
  runtimeAuthState: RuntimeAuthState | null;
  runtimeAuthRefreshCancelled: boolean;
  profileIndex: number;
  thinkLevel: ThinkLevel;
};

type RuntimeApiKeySink = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

type LogLike = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
};

/**
 * Coordinates auth profile selection, runtime auth preparation/refresh, and
 * profile failover for one embedded run. Runtime snapshots and auth refreshes
 * share this state so profile rotation cannot leave either with stale credentials.
 */
export function createEmbeddedRunAuthController(params: {
  config: RunEmbeddedAgentParams["config"];
  agentDir: string;
  workspaceDir: string;
  authStore: AuthProfileStore;
  authStorage: RuntimeApiKeySink;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  initialThinkLevel: ThinkLevel;
  attemptedThinking: Set<ThinkLevel>;
  fallbackConfigured: boolean;
  allowTransientCooldownProbe: boolean;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  authProfileStateMode?: "read-write" | "read-only";
  runId?: string;
  provider: string;
  modelId: string;
  state: EmbeddedRunAuthState;
  prepareModelForAuthProfile?(
    profileId: string | undefined,
    attemptIndex?: number,
  ): Promise<{
    runtimeModel: Model;
    authRequirement?: ProviderModelRouteAuthRequirement;
    allowAuthProfileFallback?: boolean;
    commit(): void;
  }>;
  log: LogLike;
}) {
  const { state } = params;
  // Runtime auth overlays are profile-scoped. Keep the pre-auth model so a
  // later profile cannot inherit an earlier profile's endpoint or headers.
  const baseRuntimeModel = state.models.runtime;
  const baseEffectiveModel = state.models.effective;

  const commitPreparedModel = (
    preparedModel:
      | Awaited<ReturnType<NonNullable<typeof params.prepareModelForAuthProfile>>>
      | undefined,
  ) => {
    preparedModel?.commit();
    if (preparedModel?.authRequirement) {
      return;
    }
    state.models.runtime = baseRuntimeModel;
    state.models.effective = baseEffectiveModel;
  };

  const applyPreparedRuntimeRequestOverrides = (paramsForApply: {
    runtimeModel: Model;
    preparedAuth: {
      baseUrl?: string;
      request?: ModelProviderRequestTransportOverrides;
    };
  }): void => {
    const runtimeModel = applyPreparedRuntimeAuthToModel(
      paramsForApply.runtimeModel,
      paramsForApply.preparedAuth,
    );
    if (runtimeModel === paramsForApply.runtimeModel) {
      return;
    }
    // Runtime auth plugins may override baseUrl and safe request auth headers,
    // while the shared applier strips privileged transport knobs.
    state.models.runtime = runtimeModel;
    state.models.effective = applyPreparedRuntimeAuthToModel(
      state.models.effective,
      paramsForApply.preparedAuth,
    );
  };

  const hasRefreshableRuntimeAuth = () => Boolean(state.runtimeAuthState?.sourceApiKey.trim());

  const nextRuntimeAuthGeneration = () => (state.runtimeAuthState?.generation ?? 0) + 1;

  const prepareRuntimeAuthForModel = async (prepareParams: {
    runtimeModel: Model;
    apiKey: string;
    authMode: string;
    profileId?: string;
  }) => {
    const preparedAuth = await prepareProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: prepareParams.runtimeModel.provider,
        modelId: params.modelId,
        model: prepareParams.runtimeModel,
        apiKey: unwrapSecretSentinelsForProviderEgress(
          prepareParams.apiKey,
          "provider runtime auth exchange",
        ),
        authMode: prepareParams.authMode,
        profileId: prepareParams.profileId,
      },
    });
    return protectPreparedProviderRuntimeAuth({
      provider: prepareParams.runtimeModel.provider,
      preparedAuth,
    });
  };

  // Single hard-deadline backstop applied at EVERY auth boundary that can block
  // on a provider hook, keychain read, or cross-agent lock/gate. Without it, any
  // one of those hanging leaves the model-turn lane deadlocked (the rh-bot
  // freeze). Covers the refresh path AND the cold-start/profile-rotation path.
  const withAuthDeadline = <T>(work: Promise<T>, label: string): Promise<T> =>
    withRuntimeAuthRefreshDeadline(work, RUNTIME_AUTH_REFRESH_HARD_TIMEOUT_MS, label);

  const clearRuntimeAuthRefreshTimer = () => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState?.refreshTimer) {
      return;
    }
    clearTimeout(runtimeAuthState.refreshTimer);
    runtimeAuthState.refreshTimer = undefined;
  };

  const stopRuntimeAuthRefreshTimer = () => {
    if (!state.runtimeAuthState) {
      return;
    }
    state.runtimeAuthRefreshCancelled = true;
    clearRuntimeAuthRefreshTimer();
  };

  const refreshRuntimeAuth = async (reason: string): Promise<void> => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState) {
      return;
    }
    if (runtimeAuthState.refreshInFlight) {
      await runtimeAuthState.refreshInFlight;
      return;
    }
    // Generation/profile/source checks below discard refreshes that complete
    // after another profile or credential has already become active.
    const refreshGeneration = runtimeAuthState.generation;
    const refreshProfileId = runtimeAuthState.profileId;
    const refreshOperation: Promise<void> = (async () => {
      const currentRuntimeAuthState = state.runtimeAuthState;
      const sourceApiKey = currentRuntimeAuthState?.sourceApiKey.trim() ?? "";
      if (!sourceApiKey) {
        throw new Error(`Runtime auth refresh requires a source credential.`);
      }
      const runtimeModel = state.models.runtime;
      params.log.debug(`Refreshing runtime auth for ${runtimeModel.provider} (${reason})...`);
      const preparedAuth = await prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: sourceApiKey,
        authMode: currentRuntimeAuthState?.authMode ?? "unknown",
        profileId: currentRuntimeAuthState?.profileId,
      });
      if (!preparedAuth?.apiKey) {
        throw new Error(
          `Provider "${runtimeModel.provider}" does not support runtime auth refresh.`,
        );
      }
      const activeRuntimeAuthState = state.runtimeAuthState;
      if (
        !activeRuntimeAuthState ||
        activeRuntimeAuthState.generation !== refreshGeneration ||
        activeRuntimeAuthState.profileId !== refreshProfileId ||
        activeRuntimeAuthState.sourceApiKey.trim() !== sourceApiKey
      ) {
        params.log.debug(
          `Ignoring stale runtime auth refresh for ${runtimeModel.provider}; auth state advanced before ${reason} refresh completed.`,
        );
        return;
      }
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
      applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth });
      state.runtimeAuthState = {
        ...activeRuntimeAuthState,
        expiresAt: preparedAuth.expiresAt,
      };
      if (preparedAuth.expiresAt) {
        const remaining = preparedAuth.expiresAt - Date.now();
        params.log.debug(
          `Runtime auth refreshed for ${runtimeModel.provider}; expires in ${Math.max(0, Math.floor(remaining / 1000))}s.`,
        );
      }
    })();
    // Hard backstop: a provider auth hook, keychain read, or cross-agent lock
    // wait that never settles must not leave `refreshInFlight` pending forever,
    // or every later model turn deadlocks awaiting it, freezing the gateway
    // until restart (observed in production).
    const refreshPromise: Promise<void> = withAuthDeadline(
      refreshOperation,
      state.models.runtime.provider,
    )
      .catch((err: unknown) => {
        const runtimeModel = state.models.runtime;
        if (err instanceof RuntimeAuthDeadlineError) {
          // The deadline abandons refreshOperation without cancelling it, and
          // the continuation still holds this generation's stale-check
          // snapshot. Bump the generation so the abandoned completion fails
          // that check instead of overwriting credentials a retry installs.
          const activeState = state.runtimeAuthState;
          if (activeState && activeState.generation === refreshGeneration) {
            activeState.generation = refreshGeneration + 1;
            params.log.debug(
              `Invalidated runtime auth generation ${refreshGeneration} for ${runtimeModel.provider}; deadline abandoned an in-flight refresh.`,
            );
          }
        }
        params.log.warn(
          `Runtime auth refresh failed for ${runtimeModel.provider}: ${formatErrorMessage(err)}`,
        );
        throw err;
      })
      .finally(() => {
        // Clear whenever this promise is still the active in-flight handle.
        // Intentionally not gated on generation: a profile rotation during a
        // slow/hung refresh must still release the handle it owns, otherwise the
        // stale handle wedges the new generation's refreshes. The deadline path
        // above bumps the generation itself, so a generation gate here would
        // strand the handle it just invalidated.
        const activeState = state.runtimeAuthState;
        if (activeState && activeState.refreshInFlight === refreshPromise) {
          activeState.refreshInFlight = undefined;
        }
      });
    runtimeAuthState.refreshInFlight = refreshPromise;
    await refreshPromise;
  };

  const scheduleRuntimeAuthRefresh = (): void => {
    const runtimeAuthState = state.runtimeAuthState;
    if (!runtimeAuthState || state.runtimeAuthRefreshCancelled) {
      return;
    }
    const runtimeModel = state.models.runtime;
    if (!hasRefreshableRuntimeAuth()) {
      params.log.warn(
        `Skipping runtime auth refresh scheduling for ${runtimeModel.provider}; source credential missing.`,
      );
      return;
    }
    if (!runtimeAuthState.expiresAt) {
      return;
    }
    clearRuntimeAuthRefreshTimer();
    const now = Date.now();
    const refreshAt = runtimeAuthState.expiresAt - RUNTIME_AUTH_REFRESH_MARGIN_MS;
    const delayMs = clampRuntimeAuthRefreshDelayMs({
      refreshAt,
      now,
      minDelayMs: RUNTIME_AUTH_REFRESH_MIN_DELAY_MS,
    });
    const timer = setTimeout(() => {
      if (state.runtimeAuthRefreshCancelled) {
        return;
      }
      refreshRuntimeAuth("scheduled")
        .then(() => scheduleRuntimeAuthRefresh())
        .catch(() => {
          if (state.runtimeAuthRefreshCancelled) {
            return;
          }
          const retryTimer = setTimeout(() => {
            if (state.runtimeAuthRefreshCancelled) {
              return;
            }
            refreshRuntimeAuth("scheduled-retry")
              .then(() => scheduleRuntimeAuthRefresh())
              .catch(() => undefined);
          }, RUNTIME_AUTH_REFRESH_RETRY_MS);
          const activeRuntimeAuthState = state.runtimeAuthState;
          if (activeRuntimeAuthState) {
            activeRuntimeAuthState.refreshTimer = retryTimer;
          }
          if (state.runtimeAuthRefreshCancelled && activeRuntimeAuthState) {
            clearTimeout(retryTimer);
            activeRuntimeAuthState.refreshTimer = undefined;
          }
        });
    }, delayMs);
    runtimeAuthState.refreshTimer = timer;
    if (state.runtimeAuthRefreshCancelled) {
      clearTimeout(timer);
      runtimeAuthState.refreshTimer = undefined;
    }
  };

  const resolveAuthProfileFailoverReason = (failoverParams: {
    allInCooldown: boolean;
    message: string;
    profileIds?: Array<string | undefined>;
  }): FailoverReason => {
    if (failoverParams.allInCooldown) {
      const profileIds = (failoverParams.profileIds ?? params.profileCandidates).filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      );
      return (
        resolveProfilesUnavailableReason({
          store: params.authStore,
          profileIds,
        }) ?? "unknown"
      );
    }
    const classified = classifyFailoverReason(failoverParams.message, {
      provider: params.provider,
    });
    return classified ?? "auth";
  };

  const recordOAuthRefreshFailure = async (
    candidate: string | undefined,
    error: unknown,
  ): Promise<void> => {
    if (!(error instanceof OAuthRefreshFailureError)) {
      return;
    }
    const profileId = error.profileId ?? candidate;
    const provider = error.provider || params.provider;
    const errorText = formatErrorMessage(error);
    params.log.warn(
      `auth profile "${profileId ?? "(unknown)"}" failed for provider "${provider}": ${errorText}`,
    );
    if (!profileId || params.authProfileStateMode === "read-only") {
      return;
    }
    const reason = resolveAuthProfileFailureReason({
      failoverReason: resolveAuthProfileFailoverReason({
        allInCooldown: false,
        message: errorText,
      }),
      policy: params.authProfileFailurePolicy,
    });
    if (!reason) {
      return;
    }
    try {
      await markAuthProfileFailure({
        store: params.authStore,
        profileId,
        reason,
        cfg: params.config,
        agentDir: params.agentDir,
        runId: params.runId,
        modelId: params.modelId,
      });
    } catch (markError) {
      params.log.warn(
        `auth profile "${profileId}" failure bookkeeping failed for provider "${provider}": ${formatErrorMessage(markError)}`,
      );
    }
  };

  const throwAuthProfileFailover = (failoverParams: {
    allInCooldown: boolean;
    message?: string;
    error?: unknown;
  }): never => {
    const provider = params.provider;
    const modelId = params.modelId;
    const messageForReason =
      failoverParams.message?.trim() ||
      (failoverParams.error ? formatErrorMessage(failoverParams.error).trim() : "");
    const reason = resolveAuthProfileFailoverReason({
      allInCooldown: failoverParams.allInCooldown,
      message: messageForReason,
      profileIds: params.profileCandidates,
    });
    const message =
      failoverParams.message?.trim() ||
      renderAuthProfileFailoverCopy({
        reason,
        provider,
        allInCooldown: failoverParams.allInCooldown,
        causeText: failoverParams.error
          ? formatErrorMessage(failoverParams.error).trim()
          : undefined,
        recoveryHint: buildProviderAuthRecoveryHint({
          provider,
          config: params.config,
          workspaceDir: params.workspaceDir,
          env: process.env,
        }),
      });
    if (params.fallbackConfigured) {
      const authMode =
        reason === "billing" ||
        reason === "auth" ||
        reason === "auth_permanent" ||
        reason === "session_expired"
          ? resolveSubscriptionAuthModeForProfiles({
              store: params.authStore,
              profileIds: failoverParams.allInCooldown
                ? params.profileCandidates
                : [params.profileCandidates[state.profileIndex]],
            })
          : undefined;
      throw new FailoverError(message, {
        reason,
        provider,
        model: modelId,
        authMode,
        status: resolveFailoverStatus(reason),
        code: failoverParams.error ? getFailoverErrorCode(failoverParams.error) : undefined,
        authProfileFailure: { allInCooldown: failoverParams.allInCooldown },
        cause: failoverParams.error,
      });
    }
    if (failoverParams.error instanceof Error) {
      throw failoverParams.error;
    }
    throw new Error(message);
  };

  const resolveApiKeyForCandidate = async (
    candidate?: string,
    model = state.models.runtime,
    allowAuthProfileFallback?: boolean,
  ) => {
    return getApiKeyForModelCore({
      model,
      cfg: params.config,
      profileId: candidate,
      store: params.authStore,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      lockedProfile: candidate != null && candidate === params.lockedProfileId,
      allowAuthProfileFallback,
      secretSentinels: true,
    });
  };

  const applyApiKeyInfo = async (candidate?: string, attemptIndex?: number): Promise<void> => {
    const preparedModel = await params.prepareModelForAuthProfile?.(candidate, attemptIndex);
    // Hard-deadline credential resolution: a wedged keychain/OAuth call here
    // blocks every later model turn awaiting the same single-flight, which
    // froze the gateway until restart in production (#93952).
    const apiKeyInfo = await withAuthDeadline(
      resolveApiKeyForCandidate(
        candidate,
        preparedModel?.runtimeModel,
        preparedModel?.allowAuthProfileFallback,
      ),
      `${(preparedModel?.runtimeModel ?? state.models.runtime).provider} credential resolution`,
    );
    if (
      preparedModel?.authRequirement &&
      !providerModelRouteAcceptsAuthMode({
        requirement: preparedModel.authRequirement,
        mode: apiKeyInfo.mode ?? (apiKeyInfo.apiKey ? "api-key" : undefined),
      })
    ) {
      throw new Error(
        `Resolved ${apiKeyInfo.mode ?? "unknown"} credentials are incompatible with the selected ${preparedModel.authRequirement} route for ${preparedModel.runtimeModel.provider}.`,
      );
    }
    // Preserve the checked source even when resolution fails before route commit.
    state.apiKeyInfo = apiKeyInfo;
    const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        const runtimeModel = preparedModel?.runtimeModel ?? state.models.runtime;
        throw new MissingProviderAuthError(runtimeModel.provider, apiKeyInfo);
      }
      commitPreparedModel(preparedModel);
      // AWS SDK auth via IMDS / instance role / ECS task role: no explicit API
      // key is available but the SDK default credential chain can resolve
      // credentials at runtime.  We must still call setRuntimeApiKey so that
      // OpenClaw runtime's authStorage considers the provider authenticated.  Try
      // prepareProviderRuntimeAuth first (it can sign requests and return a
      // short-lived token); fall back to a sentinel value when the provider
      // plugin does not implement runtime auth preparation.
      const runtimeModel = state.models.runtime;
      const AWS_SDK_AUTH_SENTINEL = "__aws_sdk_auth__";
      try {
        const preparedAuth = await withAuthDeadline(
          prepareRuntimeAuthForModel({
            runtimeModel,
            apiKey: AWS_SDK_AUTH_SENTINEL,
            authMode: apiKeyInfo.mode,
            profileId: apiKeyInfo.profileId,
          }),
          `${runtimeModel.provider} runtime auth`,
        );
        applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth: preparedAuth ?? {} });
        if (preparedAuth?.apiKey) {
          clearRuntimeAuthRefreshTimer();
          params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
          state.runtimeAuthState = {
            generation: nextRuntimeAuthGeneration(),
            sourceApiKey: AWS_SDK_AUTH_SENTINEL,
            authMode: apiKeyInfo.mode,
            profileId: resolvedProfileId,
            expiresAt: preparedAuth.expiresAt,
          };
          if (preparedAuth.expiresAt) {
            scheduleRuntimeAuthRefresh();
          }
          state.lastProfileId = resolvedProfileId;
          return;
        }
      } catch (error) {
        params.log.warn(
          `prepareProviderRuntimeAuth failed for ${runtimeModel.provider}, falling back to sentinel: ${formatErrorMessage(error)}`,
        );
      }
      // No runtime auth plugin resolved a real credential.  Inject the
      // sentinel so OpenClaw runtime's hasConfiguredAuth() passes and the AWS SDK default
      // credential chain handles actual request signing.
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, AWS_SDK_AUTH_SENTINEL);
      state.runtimeAuthState = null;
      state.lastProfileId = resolvedProfileId;
      return;
    }
    commitPreparedModel(preparedModel);
    let runtimeAuthHandled = false;
    const runtimeModel = state.models.runtime;
    const preparedAuth = await withAuthDeadline(
      prepareRuntimeAuthForModel({
        runtimeModel,
        apiKey: apiKeyInfo.apiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      }),
      `${runtimeModel.provider} runtime auth`,
    );
    applyPreparedRuntimeRequestOverrides({ runtimeModel, preparedAuth: preparedAuth ?? {} });
    if (preparedAuth?.apiKey) {
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, preparedAuth.apiKey);
      state.runtimeAuthState = {
        generation: nextRuntimeAuthGeneration(),
        sourceApiKey: apiKeyInfo.apiKey,
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
        expiresAt: preparedAuth.expiresAt,
      };
      if (preparedAuth.expiresAt) {
        scheduleRuntimeAuthRefresh();
      }
      runtimeAuthHandled = true;
    }
    if (!runtimeAuthHandled) {
      clearRuntimeAuthRefreshTimer();
      params.authStorage.setRuntimeApiKey(runtimeModel.provider, apiKeyInfo.apiKey);
      state.runtimeAuthState = null;
    }
    state.lastProfileId = apiKeyInfo.profileId;
  };

  const advanceAuthProfile = async (): Promise<boolean> => {
    let nextIndex = state.profileIndex + 1;
    while (nextIndex < params.profileCandidates.length) {
      const candidateIndex = nextIndex++;
      const candidate = params.profileCandidates[candidateIndex];
      // Candidate exhaustion is run-local and never depends on a cooldown write.
      state.profileIndex = candidateIndex;
      if (
        candidate &&
        isProfileInCooldown(params.authStore, candidate, undefined, params.modelId)
      ) {
        continue;
      }
      try {
        await applyApiKeyInfo(candidate, candidateIndex);
        state.thinkLevel = params.initialThinkLevel;
        params.attemptedThinking.clear();
        return true;
      } catch (err) {
        if (err instanceof SecretSurfaceUnavailableError) {
          throw err;
        }
        await recordOAuthRefreshFailure(candidate, err);
      }
    }
    state.profileIndex = params.profileCandidates.length;
    return false;
  };

  const initializeAuthProfile = async () => {
    try {
      const modelId = params.modelId;
      const cooldownProbePolicy = resolveEmbeddedAuthCooldownProbePolicy({
        authStore: params.authStore,
        profileCandidates: params.profileCandidates,
        lockedProfileId: params.lockedProfileId,
        modelId,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
      });
      let didTransientCooldownProbe = false;

      while (state.profileIndex < params.profileCandidates.length) {
        const candidate = params.profileCandidates[state.profileIndex];
        const inCooldown =
          candidate && isProfileInCooldown(params.authStore, candidate, undefined, modelId);
        if (inCooldown) {
          const canProbeCandidate =
            !didTransientCooldownProbe && cooldownProbePolicy.probeProfileIds.has(candidate);
          // Spend the single probe slot only on a transiently cooled candidate;
          // persistent failures must leave it available for later profiles.
          if (canProbeCandidate) {
            didTransientCooldownProbe = true;
            params.log.warn(
              `probing cooldowned auth profile for ${params.provider}/${modelId} due to ${cooldownProbePolicy.unavailableReason ?? "transient"} unavailability`,
            );
          } else {
            state.profileIndex += 1;
            continue;
          }
        }
        await applyApiKeyInfo(params.profileCandidates[state.profileIndex], state.profileIndex);
        break;
      }
      if (state.profileIndex >= params.profileCandidates.length) {
        throwAuthProfileFailover({ allInCooldown: true });
      }
    } catch (err) {
      if (err instanceof FailoverError || err instanceof SecretSurfaceUnavailableError) {
        throw err;
      }
      await recordOAuthRefreshFailure(params.profileCandidates[state.profileIndex], err);
      const advanced = await advanceAuthProfile();
      if (!advanced) {
        throwAuthProfileFailover({ allInCooldown: false, error: err });
      }
    }
  };

  const maybeRefreshRuntimeAuthForAuthError = async (
    errorText: string,
    retried: boolean,
  ): Promise<boolean> => {
    if (!state.runtimeAuthState || retried) {
      return false;
    }
    if (!isFailoverErrorMessage(errorText, { provider: params.provider })) {
      return false;
    }
    if (classifyFailoverReason(errorText, { provider: params.provider }) !== "auth") {
      return false;
    }
    try {
      await refreshRuntimeAuth("auth-error");
      scheduleRuntimeAuthRefresh();
      return true;
    } catch {
      return false;
    }
  };

  return {
    applyAuthProfileCandidate: applyApiKeyInfo,
    advanceAuthProfile,
    initializeAuthProfile,
    maybeRefreshRuntimeAuthForAuthError,
    stopRuntimeAuthRefreshTimer,
  };
}
