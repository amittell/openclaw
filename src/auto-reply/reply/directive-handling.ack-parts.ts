/** Builds the acknowledgement lines for a directive-only turn.
 *
 * Split out of ./directive-handling.impl.ts to keep that file within the
 * max-lines budget. Pure code motion: the parts are appended in exactly the
 * order the handler appended them inline, and the handler joins them unchanged.
 */
import type { AgentModelPrimaryWriteTarget } from "../../agents/agent-scope.js";
import type { StickyModelSelectionDispatchOutcome } from "../../agents/sticky-model-selection.js";
import type { applyModelRuntimeDirective } from "./directive-handling.model-runtime.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import {
  DIRECTIVE_ACK_MESSAGES,
  formatDirectiveAck,
  formatElevatedRuntimeHint,
  formatInternalExecPersistenceDeniedText,
  formatInternalVerboseCurrentReplyOnlyText,
  formatInternalVerbosePersistenceDeniedText,
  formatModelSelectionScopeAck,
} from "./directive-handling.shared.js";
import { appendTemperatureAck } from "./directive-handling.temperature.js";
import type { ThinkLevel } from "./directives.js";
import type { ModelDirectiveSelection } from "./model-selection.js";

/** Handler state the acknowledgement lines read, resolved before persistence ran. */
export type DirectiveAckContext = {
  allowPrivilegedPersistence: boolean;
  shouldHintDirectRuntime: boolean;
  modelSelection: ModelDirectiveSelection | undefined;
  profileOverride: string | undefined;
  modelRuntimeResolution: Parameters<typeof applyModelRuntimeDirective>[1];
  configuredDefaultUpdate: StickyModelSelectionDispatchOutcome | undefined;
  stickyModelSelectionTarget: AgentModelPrimaryWriteTarget | undefined;
  shouldRemapUnsupportedThinkLevel: boolean;
  remappedUnsupportedThinkLevel: ThinkLevel | undefined;
  nextThinkLevel: ThinkLevel | undefined;
  resolvedProvider: string;
  resolvedModel: string;
};

/** Renders the applied directives as acknowledgement fragments, in report order. */
export function buildDirectiveAckParts(
  directives: InlineDirectives,
  context: DirectiveAckContext,
): string[] {
  const {
    allowPrivilegedPersistence,
    shouldHintDirectRuntime,
    modelSelection,
    profileOverride,
    modelRuntimeResolution,
    configuredDefaultUpdate,
    stickyModelSelectionTarget,
    shouldRemapUnsupportedThinkLevel,
    remappedUnsupportedThinkLevel,
    nextThinkLevel,
    resolvedProvider,
    resolvedModel,
  } = context;
  const parts: string[] = [];
  if (directives.clearThinkLevel) {
    parts.push("Thinking level reset to default.");
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
  }
  appendTemperatureAck(directives, parts);
  if (directives.clearFastMode) {
    parts.push(formatDirectiveAck("Fast mode reset to default."));
  } else if (directives.hasFastDirective && directives.fastMode !== undefined) {
    parts.push(
      directives.fastMode === "auto"
        ? formatDirectiveAck("Fast mode set to auto.")
        : directives.fastMode
          ? formatDirectiveAck("Fast mode enabled.")
          : formatDirectiveAck("Fast mode disabled."),
    );
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    const message = allowPrivilegedPersistence
      ? DIRECTIVE_ACK_MESSAGES.verbose[directives.verboseLevel]
      : formatInternalVerboseCurrentReplyOnlyText();
    parts.push(formatDirectiveAck(message));
  }
  if (directives.hasTraceDirective && directives.traceLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.trace[directives.traceLevel]));
  }
  if (directives.hasVerboseDirective && directives.verboseLevel && !allowPrivilegedPersistence) {
    parts.push(formatDirectiveAck(formatInternalVerbosePersistenceDeniedText()));
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.reasoning[directives.reasoningLevel]));
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.elevated[directives.elevatedLevel]));
    if (shouldHintDirectRuntime) {
      parts.push(formatElevatedRuntimeHint());
    }
  }
  if (directives.hasExecDirective && directives.hasExecOptions) {
    for (const [label, options] of [
      [
        allowPrivilegedPersistence && "Exec defaults set",
        { host: directives.execHost, node: directives.execNode },
      ],
      [
        "Exec policy for this run only",
        { security: directives.execSecurity, ask: directives.execAsk },
      ],
    ] as const) {
      const execParts = Object.entries(options)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}=${value}`);
      if (execParts.length > 0) {
        const message = label
          ? `${label} (${execParts.join(", ")}).`
          : formatInternalExecPersistenceDeniedText();
        parts.push(formatDirectiveAck(message));
      }
    }
  }
  if (modelSelection) {
    const label = `${modelSelection.provider}/${modelSelection.model}`;
    const labelWithAlias = modelSelection.alias ? `${modelSelection.alias} (${label})` : label;
    parts.push(
      formatModelSelectionScopeAck({
        isDefault: modelSelection.isDefault,
        label: labelWithAlias,
        configuredDefaultUpdate,
        ...(stickyModelSelectionTarget ? { stickyModelSelectionTarget } : {}),
      }),
    );
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
    if (modelRuntimeResolution.kind === "clear") {
      parts.push("Runtime reset to configured policy.");
    } else if (modelRuntimeResolution.kind === "set") {
      parts.push(`Runtime set to ${modelRuntimeResolution.runtime} for this session.`);
    }
  }
  // Report the model change before the thinking remap it triggered: the remap is a
  // consequence of the model switch, so the cause should be announced first.
  if (
    !directives.hasThinkDirective &&
    shouldRemapUnsupportedThinkLevel &&
    remappedUnsupportedThinkLevel
  ) {
    parts.push(
      `Thinking level set to ${remappedUnsupportedThinkLevel} (${nextThinkLevel} not supported for ${resolvedProvider}/${resolvedModel}).`,
    );
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(formatDirectiveAck(`Queue mode set to ${directives.queueMode}.`));
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(formatDirectiveAck("Queue mode reset to default."));
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    parts.push(formatDirectiveAck(`Queue debounce set to ${directives.debounceMs}ms.`));
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(formatDirectiveAck(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(formatDirectiveAck(`Queue drop set to ${directives.dropPolicy}.`));
  }
  return parts;
}
