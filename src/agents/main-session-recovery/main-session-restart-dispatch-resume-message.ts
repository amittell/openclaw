import type { MainRestartRecoveryCause } from "../../config/sessions.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SUBAGENT_RESTART_RECOVERY_INSTRUCTION } from "../subagents/subagent-restart-recovery-prompt.js";
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";

// Used only when a Gateway close recorded the "gateway_restart" cause. 10.7 made the shared
// RESTART_RECOVERY_INTERRUPTION_NOTE cause-neutral, so this variant states the restart itself.
const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. " +
    "Treat tool results marked interrupted, missing, or aborted as having an unknown outcome " +
    "from the restart, not proof of tool failure. Verify what happened before repeating an action. " +
    "The restart did not cancel the user's task. " +
    "Continue from the existing transcript: check the current state, recover interrupted work, " +
    "and finish the task without asking the user to repeat the request. " +
    `${SUBAGENT_RESTART_RECOVERY_INSTRUCTION} ${TOOL_FAILURE_INSTRUCTION}`,
);

// Used whenever no restart is on record: an explicit operator recovery, a pre-upgrade
// cycle, or any cycle without the "gateway_restart" cause. It never claims a restart.
// Mirrors the restart variant above without claiming the restart.
const INTERRUPT_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted while OpenClaw was waiting on tool/model work. " +
    "Treat tool results marked interrupted, missing, or aborted as having an unknown outcome, " +
    "not proof of tool failure. Verify what happened before repeating an action. " +
    "The interruption did not cancel the user's task. " +
    "Continue from the existing transcript: check the current state, recover interrupted work, " +
    "and finish the task without asking the user to repeat the request. " +
    `${SUBAGENT_RESTART_RECOVERY_INSTRUCTION} ${TOOL_FAILURE_INSTRUCTION}`,
);

/** Resume instructions for a recovery cycle; only a recorded "gateway_restart" names a restart. */
export function resolveRestartRecoveryResumeMessage(cause?: MainRestartRecoveryCause): string {
  return cause === "gateway_restart"
    ? RESTART_RECOVERY_RESUME_MESSAGE
    : INTERRUPT_RECOVERY_RESUME_MESSAGE;
}
