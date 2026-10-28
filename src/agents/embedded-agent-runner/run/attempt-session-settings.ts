import type { ContextEngine } from "../../../context-engine/types.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../../agent-settings.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** The attempt's settings manager, with the auto-compaction guard already applied. */
export function prepareEmbeddedAttemptSettingsManager(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngineInfo?: ContextEngine["info"];
  agentDir: string;
  effectiveCwd: string;
  pluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
}) {
  const { attempt } = input;
  const settingsManager = createPreparedEmbeddedAgentSettingsManager({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    cfg: attempt.config,
    pluginMetadataSnapshot: input.pluginMetadataSnapshot,
    contextTokenBudget: attempt.contextTokenBudget,
  });
  applyAgentAutoCompactionGuard({
    settingsManager,
    contextEngineInfo: input.activeContextEngineInfo,
    compactionMode: resolveEffectiveCompactionMode(attempt.config),
    silentOverflowProneProvider: isSilentOverflowProneModel({
      provider: attempt.provider,
      modelId: attempt.modelId,
      baseUrl: attempt.model.baseUrl ?? undefined,
    }),
    // The finalizer's result gate rejects any compaction, so never start one.
    compactionForbidden: attempt.operation === "settled-tool-finalization",
  });
  return settingsManager;
}
