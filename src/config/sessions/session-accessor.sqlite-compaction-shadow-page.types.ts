import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";

export type SessionTranscriptCompactionShadowPageOptions = {
  compactionId: string;
  maxMessages: number;
  offset: number;
};

export type SessionTranscriptCompactionShadowPage = {
  displaySource?: string;
  /** `seq` is span-relative (1 = oldest shadowed row) so offset paging math is shared. */
  events: SessionTranscriptMessageEvent[];
  offset: number;
  shadowedCount: number;
};
