/** Transient-cooldown probe policy for the embedded run auth controller.
 *
 * Split out of ./auth-controller.ts to keep that module within the max-lines
 * budget. The export is re-exported from ./auth-controller.ts so existing
 * import paths are unchanged.
 */
import {
  type AuthProfileStore,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
} from "../../auth-profiles.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { shouldUseTransientCooldownProbeSlot } from "../../failover-policy.js";

/** Decides whether one automatic profile may bypass its current cooldown. */
export function resolveEmbeddedAuthCooldownProbePolicy(params: {
  authStore: AuthProfileStore;
  profileCandidates: Array<string | undefined>;
  lockedProfileId?: string;
  modelId: string;
  allowTransientCooldownProbe: boolean;
}): { probeProfileIds: ReadonlySet<string>; unavailableReason: FailoverReason | null } {
  const autoProfileCandidates = params.profileCandidates.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0 && candidate !== params.lockedProfileId,
  );
  const allAutoProfilesInCooldown =
    autoProfileCandidates.length > 0 &&
    autoProfileCandidates.every((candidate) =>
      isProfileInCooldown(params.authStore, candidate, undefined, params.modelId),
    );
  const unavailableReason = allAutoProfilesInCooldown
    ? (resolveProfilesUnavailableReason({
        store: params.authStore,
        profileIds: autoProfileCandidates,
      }) ?? "unknown")
    : null;
  const probeProfileIds = new Set<string>();
  if (
    params.allowTransientCooldownProbe &&
    allAutoProfilesInCooldown &&
    shouldUseTransientCooldownProbeSlot(unavailableReason)
  ) {
    for (const candidate of autoProfileCandidates) {
      const candidateReason =
        resolveProfilesUnavailableReason({
          store: params.authStore,
          profileIds: [candidate],
        }) ?? "unknown";
      if (shouldUseTransientCooldownProbeSlot(candidateReason)) {
        probeProfileIds.add(candidate);
      }
    }
  }
  return { probeProfileIds, unavailableReason };
}
