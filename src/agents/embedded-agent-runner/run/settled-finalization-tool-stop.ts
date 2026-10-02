import type { Agent } from "../../runtime/index.js";
import { log } from "../logger.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Tool-free settled-turn finalization registers no tools, so every tool call it
 * receives fails as unknown. Answering each "Tool X not found" with another
 * model call let a model loop through several such rounds; end the pass at the
 * first tool call and leave the verdict to the finalization result owner.
 * Every other attempt, including other tools-disabled ones, keeps its loop.
 */
export function installSettledFinalizationToolCallStop(
  agent: Agent,
  attempt: Pick<EmbeddedRunAttemptParams, "operation" | "disableTools" | "runId">,
): void {
  if (attempt.operation !== "settled-tool-finalization" || attempt.disableTools !== true) {
    return;
  }
  const continueTurn = agent.prepareNextTurnWithContext;
  agent.prepareNextTurnWithContext = async (turn, signal) => {
    const toolNames = turn.message.content.flatMap((block) =>
      block.type === "toolCall" ? [block.name] : [],
    );
    if (toolNames.length > 0) {
      log.warn(
        `settled-turn finalization stopped at its first tool call: runId=${attempt.runId} ` +
          `tools=${toolNames.join(",")} — tools are disabled, not re-prompting`,
      );
      return { stop: true };
    }
    return continueTurn
      ? await continueTurn.call(agent, turn, signal)
      : await agent.prepareNextTurn?.(signal);
  };
}
