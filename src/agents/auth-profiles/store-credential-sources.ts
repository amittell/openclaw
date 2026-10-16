/** Runtime credential-source tagging for auth profile store read views.
 *
 * Split out of ./store.ts to keep that module within the max-lines budget.
 */
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

export function withCredentialSources(
  store: AuthProfileStore,
  databasePath: string,
): RuntimeAuthProfileStore {
  return {
    ...store,
    runtimeCredentialSources: Object.fromEntries(
      Object.entries(store.profiles).map(([profileId, credential]) => [
        profileId,
        { databasePath, provider: credential.provider },
      ]),
    ),
  };
}
