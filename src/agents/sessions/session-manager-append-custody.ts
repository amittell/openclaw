import {
  captureSessionTranscriptQuestionAnswers,
  resolveSessionTranscriptReadFence,
} from "../../config/sessions/session-transcript-read-fence.js";

type AppendCustodyScope = Parameters<typeof resolveSessionTranscriptReadFence>[0] & {
  storePath: string;
  sessionId: string;
};

/**
 * Reads the admitted user turn a message append is fenced to and, for a turn-validating append,
 * the accepted question answers that turn owns. The write view carries both to the metadata
 * worker, which validates the prepared parent against these answers rather than re-reading
 * them after the hop, and the caller asserts they are still current before it commits (#169306).
 */
export function captureAppendCustody(
  scope: AppendCustodyScope,
  message: { validateTurn?: boolean } | undefined,
) {
  const admission = resolveSessionTranscriptReadFence(scope);
  const questionAnswers = message?.validateTurn
    ? captureSessionTranscriptQuestionAnswers(
        { path: scope.storePath },
        scope.sessionId,
        admission?.entryId,
      )
    : undefined;
  return { questionAnswers, view: { admission, questionAnswers: questionAnswers?.answers } };
}
