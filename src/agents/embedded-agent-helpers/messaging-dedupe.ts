/**
 * Normalizes outbound message text to suppress duplicate send actions.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MIN_DUPLICATE_TEXT_LENGTH = 10;
const MIN_SUBSTRING_DUPLICATE_RATIO = 0.5;

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return normalizeLowercaseStringOrEmpty(text)
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compare already-normalized message text against prior sends. */
export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) {
    return false;
  }
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) {
      return false;
    }
    if (normalized === normalizedSent) {
      return true;
    }
    if (normalized.includes(normalizedSent)) {
      // A follow-up that EXTENDS a prior send carries text the user has never
      // seen, and no length ratio can separate "<prior>. All good!" from
      // "<prior>. Actually it failed." - both are the prior plus a short tail.
      // Suppressing the pair swallows a CORRECTION because it quotes the thing
      // it corrects, and the model is then told the message was delivered.
      // A prior that is a PREFIX is therefore a duplicate only when the tail adds
      // nothing readable: "deployment finished" -> "deployment finished." is the
      // same message again, while "...Actually it failed." is not. An emoji-only
      // tail normalizes away and already compares equal above, so without this
      // check a "." tail would deliver while an emoji tail suppressed. A prior
      // that appears later in the text is re-narration ("I sent the message:
      // ...") and keeps the original ratio rule.
      if (normalized.startsWith(normalizedSent)) {
        return !/[\p{L}\p{N}]/u.test(normalized.slice(normalizedSent.length));
      }
      return normalizedSent.length >= normalized.length * MIN_SUBSTRING_DUPLICATE_RATIO;
    }
    return (
      normalizedSent.includes(normalized) &&
      normalized.length >= normalizedSent.length * MIN_SUBSTRING_DUPLICATE_RATIO
    );
  });
}

/** Return true when raw message text duplicates a prior sent message. */
export function isMessagingToolDuplicate(text: string, sentTexts: string[]): boolean {
  if (sentTexts.length === 0) {
    return false;
  }
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}
