import type { OpenClawConfig } from "../../config/config.js";
import { buildProviderAuthDoctorHintWithPlugin } from "../../plugins/provider-runtime.runtime.js";
import { normalizeProviderId } from "../model-selection.js";
import type { AuthProfileStore } from "./types.js";

/**
 * Sanitize a profile ID before embedding it in error messages or log output.
 * Strips ANSI escape sequences and control characters to prevent terminal/log
 * injection via crafted profile IDs.
 *
 * Handles CSI, OSC, DCS/SOS/PM/APC, and bare ESC sequences.
 */
export function sanitizeProfileIdForDisplay(id: string): string {
  return (
    id
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[\s\S]?)/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
  );
}

/**
 * Migration hints for deprecated/removed OAuth providers.
 * Users with stale credentials should be guided to migrate.
 */
const DEPRECATED_PROVIDER_MIGRATION_HINTS: Record<string, string> = {
  "qwen-portal":
    "Qwen OAuth via portal.qwen.ai has been deprecated. Please migrate to Model Studio (Alibaba Cloud Coding Plan). Run: openclaw onboard --auth-choice modelstudio-api-key (or modelstudio-api-key-cn for the China endpoint).",
};

export async function formatAuthDoctorHint(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): Promise<string> {
  const normalizedProvider = normalizeProviderId(params.provider);

  // Check for deprecated provider migration hints first
  const migrationHint = DEPRECATED_PROVIDER_MIGRATION_HINTS[normalizedProvider];
  if (migrationHint) {
    return migrationHint;
  }

  const pluginHint = await buildProviderAuthDoctorHintWithPlugin({
    provider: normalizedProvider,
    context: {
      config: params.cfg,
      store: params.store,
      provider: normalizedProvider,
      profileId: params.profileId,
    },
  });
  if (typeof pluginHint === "string" && pluginHint.trim()) {
    return pluginHint;
  }
  return "";
}
