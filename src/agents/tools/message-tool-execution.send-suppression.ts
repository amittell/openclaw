/** Outbound send-suppression bookkeeping for the message tool.
 *
 * Split out of ./message-tool-execution.ts to keep that file within the
 * max-lines budget. Holds the module-scoped duplicate-send state, keyed by
 * resolvePollVoteEchoRoute like the poll-vote echo state that upstream owns in
 * ./poll-vote-echo.ts. Tests reset both trackers through this module.
 */
import { resetPollVoteEchoForTest } from "./poll-vote-echo.js";

// Duplicate-send guard: models that re-narrate after each tool result
// (thinking-mode and small models especially) can call send twice with
// near-identical text in one run, double-posting the channel. Keyed per run
// (session fallback) and route-checked like the poll-vote echo; TTL +
// bounded list so a long-lived gateway cannot accumulate state.
export const DUPLICATE_SEND_TTL_MS = 10 * 60 * 1000;
export const DUPLICATE_SEND_MAX_TRACKED_PER_RUN = 8;
// Both directions must be within 2x length so a short earlier send can never
// suppress a genuinely longer follow-up that merely quotes it.
export const DUPLICATE_SEND_MIN_LENGTH_RATIO = 0.5;
export const recentMessageToolSendsByRun = new Map<
  string,
  { sends: { route: string; normalized: string }[]; recordedAt: number }
>();

/**
 * Clears both suppression trackers. These are module-level maps keyed by run and
 * session, so a suite that reuses one runId across logically distinct runs would
 * otherwise carry one case's sends into the next and suppress them.
 */
export function resetMessageToolSendSuppressionForTest(): void {
  recentMessageToolSendsByRun.clear();
  resetPollVoteEchoForTest();
}
