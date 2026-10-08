/** Outbound send-suppression bookkeeping for the message tool.
 *
 * Split out of ./message-tool-execution.ts to keep that file within the
 * max-lines budget. Holds the module-scoped poll-vote-echo and duplicate-send
 * state; both are keyed by resolvePollVoteEchoRoute, which upstream owns in
 * ./poll-vote-echo.ts. Tests reset the trackers through this module.
 */

export const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Keyed by agent session (conversation), NOT per message-tool instance: a native
// poll and its accompanying comment arrive as separate inbound messages and are
// processed in separate agent runs, each with a fresh tool instance. An
// instance-local record would be lost before the follow-up text run, so the echo
// (the agent restating its vote in prose) would leak. Session-scoped +
// route-checked storage lets the vote in one run suppress the restatement in the
// next while never crossing conversations. Single slot per session, TTL-bounded.
export const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

// Duplicate-send guard: models that re-narrate after each tool result
// (thinking-mode and small models especially) can call send twice with
// near-identical text in one run, double-posting the channel. Keyed per run
// (session fallback) and route-checked like the poll-vote echo above; TTL +
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
  recentPollVoteBySession.clear();
}
