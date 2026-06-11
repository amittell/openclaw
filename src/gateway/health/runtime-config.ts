import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { RuntimeConfigSnapshotMetadata } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RuntimeConfigHealthSummary } from "./types.js";

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

export type RuntimeHealthConfigState = {
  config: OpenClawConfig;
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
  return `{${Object.keys(record)
    .toSorted()
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
  const primary = asNullableRecord(value)?.primary;
  return typeof primary === "string" && primary.trim() ? primary.trim() : null;
}

function resolveDefaultModelLabel(config: OpenClawConfig): string | null {
  const defaults = asNullableRecord(asNullableRecord(config.agents)?.defaults);
  return readPrimaryModelLabel(defaults?.model) ?? readPrimaryModelLabel(defaults?.models);
}

function listRuntimeConfigDriftPaths(params: {
  liveSourceConfig: OpenClawConfig;
  diskSourceConfig: OpenClawConfig;
}): string[] {
  return RUNTIME_CONFIG_DRIFT_PATHS.filter((path) => {
    const liveValue = readConfigPathValue(params.liveSourceConfig, path);
    const diskValue = readConfigPathValue(params.diskSourceConfig, path);
    return stableHealthValueStringify(liveValue) !== stableHealthValueStringify(diskValue);
  });
}

/** Build the source-config drift summary for the caller's trust boundary. */
export function buildRuntimeConfigHealthSummary(
  state: RuntimeHealthConfigState,
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
  return {
    state: driftPaths.length > 0 ? "drift" : "ok",
    ...(includeFingerprints
      ? {
          liveSourceFingerprint:
            state.metadata?.sourceFingerprint ?? state.hashConfigValue(liveSourceConfig),
          diskSourceFingerprint: state.hashConfigValue(state.diskSourceConfig),
        }
      : {}),
    liveDefaultModel: resolveDefaultModelLabel(liveSourceConfig),
    diskDefaultModel: resolveDefaultModelLabel(state.diskSourceConfig),
    ...(driftPaths.length > 0
      ? {
          driftPaths,
          message:
            "Live gateway runtime config differs from disk for model/provider/auth paths; restart is required or pending.",
        }
      : {}),
  };
}

/** Read both the applied runtime source and the current disk source. */
export async function readRuntimeHealthConfigState(): Promise<RuntimeHealthConfigState> {
  const configRuntime = await import("../../config/config.js");
  const config = configRuntime.getRuntimeConfig();
  let diskSourceConfig: OpenClawConfig | null = null;
  let diskReadError: string | undefined;
  try {
    const snapshot = await configRuntime.readSourceConfigSnapshot();
    if (!snapshot.exists) {
      diskReadError = `Disk config file not found at ${snapshot.path}.`;
    } else if (!snapshot.valid) {
      const issueDetail = snapshot.issues.length > 0 ? `: ${snapshot.issues[0]?.message}` : "";
      diskReadError = `Disk config is invalid${issueDetail}`;
    } else {
      diskSourceConfig = snapshot.sourceConfig;
    }
  } catch (error) {
    diskReadError = formatErrorMessage(error);
  }
  return {
    config,
    sourceConfig: configRuntime.getRuntimeConfigSourceSnapshot(),
    metadata: configRuntime.getRuntimeConfigSnapshotMetadata(),
    diskSourceConfig,
    ...(diskReadError ? { diskReadError } : {}),
    hashConfigValue: configRuntime.hashRuntimeConfigValue,
  };
}
