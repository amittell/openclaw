/** Detects and renders drift between the live Gateway config and its disk source. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthSummary, RuntimeConfigHealthSummary } from "../gateway/health/types.js";

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
  hasMetadata: boolean;
  diskSourceConfig: OpenClawConfig | null;
};

const loadConfigRuntime = async () => await import("../config/config.js");

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
): RuntimeConfigHealthSummary | undefined {
  const liveSourceConfig = state.sourceConfig;
  if (!liveSourceConfig) {
    return state.hasMetadata
      ? {
          state: "unknown",
          message: "Runtime source config snapshot is unavailable.",
        }
      : undefined;
  }
  if (!state.diskSourceConfig) {
    return {
      state: "unknown",
      liveDefaultModel: resolveDefaultModelLabel(liveSourceConfig),
      message: "Disk config source snapshot is unavailable.",
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

/** Formats runtime-config drift for normal text health output. */
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
    // Missing runtime or disk sources must stay visible without blaming the
    // wrong side of the comparison.
    const reason = runtimeConfig.message?.trim() || "config source unavailable";
    return `Runtime config: warning (unknown source: ${reason})`;
  }
  return null;
}

async function readRuntimeConfigDriftState(): Promise<RuntimeConfigDriftState> {
  const configRuntime = await loadConfigRuntime();
  const sourceConfig = configRuntime.getRuntimeConfigSourceSnapshot();
  const hasMetadata = configRuntime.getRuntimeConfigSnapshotMetadata() !== null;
  // No live source means there is no comparison. Non-Gateway processes must
  // not turn this diagnostic into another disk-config polling path.
  if (!sourceConfig) {
    return { sourceConfig, hasMetadata, diskSourceConfig: null };
  }
  let diskSourceConfig: OpenClawConfig | null = null;
  // Missing or invalid disk config is unknown, not an empty config drift.
  try {
    const snapshot = await configRuntime.readSourceConfigSnapshot();
    if (snapshot.exists && snapshot.valid) {
      diskSourceConfig = snapshot.sourceConfig as OpenClawConfig;
    }
  } catch {
    diskSourceConfig = null;
  }
  return {
    sourceConfig,
    hasMetadata,
    diskSourceConfig,
  };
}

/** Builds the runtime-config diagnostic attached to Gateway health snapshots. */
export async function buildRuntimeConfigHealth(): Promise<RuntimeConfigHealthSummary | undefined> {
  const state = await readRuntimeConfigDriftState();
  return buildRuntimeConfigHealthSummary(state);
}
