/** Runtime-config drift diagnostics for `openclaw health` (#89526).
 *
 * Split out of ./health.ts to keep the health command within the max-lines
 * budget. Exports are re-exported from ./health.ts so existing import paths
 * are unchanged.
 */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { RuntimeConfigSnapshotMetadata } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthSummary, RuntimeConfigHealthSummary } from "../gateway/health/types.js";
import { formatErrorMessage } from "../infra/errors.js";

const loadConfigRuntime = async () => await import("../config/config.js");

const RUNTIME_CONFIG_DRIFT_PATHS = [
  "agents.defaults.model",
  "agents.defaults.models",
  "agents.list",
  "models",
  "gateway.auth",
  "auth.profiles",
  "auth.order",
  "secrets.providers",
] as const;

type RuntimeConfigDriftState = {
  sourceConfig: OpenClawConfig | null;
  metadata: RuntimeConfigSnapshotMetadata | null;
  diskSourceConfig: OpenClawConfig | null;
  diskReadError?: string;
  hashConfigValue: (config: OpenClawConfig) => string;
};

function stableHealthValueStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableHealthValueStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableHealthValueStringify(record[key])}`)
    .join(",")}}`;
}

function readConfigPathValue(config: OpenClawConfig, path: string): unknown {
  let current: unknown = config;
  for (const part of path.split(".")) {
    const record = asNullableRecord(current);
    if (!record || !Object.hasOwn(record, part)) {
      return undefined;
    }
    current = record[part];
  }
  return current;
}

function readPrimaryModelLabel(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asNullableRecord(value);
  const primary = record?.primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : null;
}

function resolveDefaultModelLabel(config: OpenClawConfig): string | null {
  const agents = asNullableRecord(config.agents);
  const defaults = asNullableRecord(agents?.defaults);
  // `agents.defaults.model` is the default-model selector; `agents.defaults.models`
  // is a catalog map and never carries a primary label, so it is not consulted.
  return readPrimaryModelLabel(defaults?.model);
}

function listRuntimeConfigDriftPaths(params: {
  liveSourceConfig: OpenClawConfig;
  diskSourceConfig: OpenClawConfig;
}): string[] {
  const driftPaths: string[] = [];
  for (const path of RUNTIME_CONFIG_DRIFT_PATHS) {
    const liveValue = readConfigPathValue(params.liveSourceConfig, path);
    const diskValue = readConfigPathValue(params.diskSourceConfig, path);
    if (stableHealthValueStringify(liveValue) !== stableHealthValueStringify(diskValue)) {
      driftPaths.push(path);
    }
  }
  return driftPaths;
}

function buildRuntimeConfigHealthSummary(
  state: RuntimeConfigDriftState,
  opts: { includeFingerprints?: boolean } = {},
): RuntimeConfigHealthSummary | undefined {
  const includeFingerprints = opts.includeFingerprints === true;
  const liveSourceConfig = state.sourceConfig;
  if (!liveSourceConfig) {
    return state.metadata
      ? {
          state: "unknown",
          ...(includeFingerprints
            ? { liveSourceFingerprint: state.metadata.sourceFingerprint }
            : {}),
          message: "Runtime source config snapshot is unavailable.",
        }
      : undefined;
  }
  if (!state.diskSourceConfig) {
    // The disk-read error string can include a filesystem path
    // (`snapshot.path`) or a JSON-parse error excerpt. Non-admin callers see
    // `openclaw health` through the `operator.read` scope, so the detailed
    // disk message is gated behind `includeFingerprints` (admin-only) and a
    // generic message is returned for non-sensitive snapshots to keep the
    // operator's filesystem layout and parse-error excerpts inside the
    // gateway-auth boundary.
    const detailedMessage = state.diskReadError
      ? `Could not read disk config source snapshot: ${state.diskReadError}`
      : "Disk config source snapshot is unavailable.";
    return {
      state: "unknown",
      ...(includeFingerprints
        ? {
            liveSourceFingerprint:
              state.metadata?.sourceFingerprint ?? state.hashConfigValue(liveSourceConfig),
          }
        : {}),
      liveDefaultModel: resolveDefaultModelLabel(liveSourceConfig),
      message: includeFingerprints
        ? detailedMessage
        : "Disk config source snapshot is unavailable.",
    };
  }
  const driftPaths = listRuntimeConfigDriftPaths({
    liveSourceConfig,
    diskSourceConfig: state.diskSourceConfig,
  });
  const liveDefaultModel = resolveDefaultModelLabel(liveSourceConfig);
  const diskDefaultModel = resolveDefaultModelLabel(state.diskSourceConfig);
  return {
    state: driftPaths.length > 0 ? "drift" : "ok",
    ...(includeFingerprints
      ? {
          liveSourceFingerprint:
            state.metadata?.sourceFingerprint ?? state.hashConfigValue(liveSourceConfig),
          diskSourceFingerprint: state.hashConfigValue(state.diskSourceConfig),
        }
      : {}),
    liveDefaultModel,
    diskDefaultModel,
    ...(driftPaths.length > 0
      ? {
          driftPaths,
          message:
            "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
        }
      : {}),
  };
}

export function formatRuntimeConfigHealthLine(summary: HealthSummary): string | null {
  const runtimeConfig = summary.runtimeConfig;
  if (!runtimeConfig) {
    return null;
  }
  if (runtimeConfig.state === "drift") {
    const paths = runtimeConfig.driftPaths?.length
      ? runtimeConfig.driftPaths.join(", ")
      : "model/provider/auth config";
    const modelDetail =
      runtimeConfig.liveDefaultModel || runtimeConfig.diskDefaultModel
        ? `; live=${runtimeConfig.liveDefaultModel ?? "unknown"} disk=${
            runtimeConfig.diskDefaultModel ?? "unknown"
          }`
        : "";
    return `Runtime config: warning (live gateway differs from disk for ${paths}; restart required or pending${modelDetail})`;
  }
  if (runtimeConfig.state === "unknown") {
    // Render the unknown state so a missing/invalid/unreadable disk config
    // surfaces in normal text `openclaw health` output. Without this, the
    // drift detector returns `state: "unknown"` in JSON but the text
    // formatter silently drops the diagnostic exactly when operators most
    // need to know the disk side cannot be compared.
    const reason = runtimeConfig.message?.trim() || "disk source unavailable";
    return `Runtime config: warning (unknown disk source: ${reason})`;
  }
  return null;
}

async function readRuntimeConfigDriftState(): Promise<RuntimeConfigDriftState> {
  const configRuntime = await loadConfigRuntime();
  const sourceConfig = configRuntime.getRuntimeConfigSourceSnapshot();
  const metadata = configRuntime.getRuntimeConfigSnapshotMetadata();
  const hashConfigValue = configRuntime.hashRuntimeConfigValue;
  // Without a live source snapshot there is nothing to compare against, so
  // skip the disk read entirely (processes outside a running gateway never
  // set the snapshot and should not poll the config file from here).
  if (!sourceConfig) {
    return { sourceConfig, metadata, diskSourceConfig: null, hashConfigValue };
  }
  let diskSourceConfig: OpenClawConfig | null = null;
  let diskReadError: string | undefined;
  // Distinguish "valid empty config on disk" from "couldn't read or parse".
  // `readSourceConfigBestEffort` returns `{}` for both the missing-file and
  // parse-failure cases, which would otherwise feed into the drift comparison
  // and report `state: "drift"` with restart-required wording even though
  // the disk side is actually unknown/invalid. Use the richer snapshot reader
  // and only treat the parsed `sourceConfig` as comparable when both `exists`
  // and `valid` are true; otherwise propagate an explicit diskReadError so
  // `buildRuntimeConfigHealthSummary` returns `state: "unknown"` with the
  // right operator-facing message.
  try {
    const snapshot = await configRuntime.readSourceConfigSnapshot();
    if (!snapshot.exists) {
      diskReadError = `Disk config file not found at ${snapshot.path}.`;
    } else if (!snapshot.valid) {
      const issueDetail = snapshot.issues.length > 0 ? `: ${snapshot.issues[0]?.message}` : "";
      diskReadError = `Disk config is invalid${issueDetail}`;
    } else {
      diskSourceConfig = snapshot.sourceConfig as OpenClawConfig;
    }
  } catch (error) {
    diskReadError = formatErrorMessage(error);
  }
  return {
    sourceConfig,
    metadata,
    diskSourceConfig,
    ...(diskReadError ? { diskReadError } : {}),
    hashConfigValue,
  };
}

export async function buildRuntimeConfigHealth(
  opts: { includeFingerprints?: boolean } = {},
): Promise<RuntimeConfigHealthSummary | undefined> {
  const state = await readRuntimeConfigDriftState();
  return buildRuntimeConfigHealthSummary(state, opts);
}
