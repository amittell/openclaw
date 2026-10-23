import { escapeRegExp } from "../../shared/regexp.js";
import {
  type ReasoningLevel,
  type TraceLevel,
  type ElevatedLevel,
  normalizeFastMode,
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeTemperature,
  normalizeTraceLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.shared.js";
import { removeDirectiveSpan, skipDirectiveArgPrefix } from "./directive-parsing.js";

type NamedLevelDirective<T, Field extends string> = {
  cleaned: string;
  rawLevel?: string;
  hasDirective: boolean;
} & {
  [Key in Field]?: T;
};

type LevelDirectiveParseOptions = {
  strict?: boolean;
};

const compileDirectivePattern = (names: readonly string[]): RegExp => {
  const namePattern = names.map(escapeRegExp).join("|");
  return new RegExp(`(?<!\\S)\\/(?:${namePattern})(?=$|\\s|:)`, "i");
};

function createLevelDirectiveExtractor<T, Field extends string>(
  names: readonly string[],
  field: Field,
  normalize: (raw?: string) => T | undefined,
): (body?: string, options?: LevelDirectiveParseOptions) => NamedLevelDirective<T, Field> {
  const pattern = compileDirectivePattern(names);
  return (body, options) => {
    if (!body) {
      return { cleaned: "", hasDirective: false } as NamedLevelDirective<T, Field>;
    }
    const match = pattern.exec(body);
    let cleaned = body;
    let rawLevel: string | undefined;
    if (match) {
      const start = match.index;
      const directiveEnd = start + match[0].length;
      const prefixEnd = directiveEnd + skipDirectiveArgPrefix(body.slice(directiveEnd));
      const argument = (options?.strict ? /^\s*(\S+)/ : /^\s*([A-Za-z-]+)/).exec(
        body.slice(prefixEnd),
      );
      const end = prefixEnd + (argument?.[0].length ?? 0);
      const candidate = argument?.[1];
      if (
        candidate !== undefined &&
        (options?.strict ||
          normalize(candidate) !== undefined ||
          body.slice(end).trim().length === 0)
      ) {
        rawLevel = candidate;
      }
      cleaned = removeDirectiveSpan(body, start, rawLevel === undefined ? prefixEnd : end);
    }
    return {
      cleaned,
      [field]: match ? normalize(rawLevel) : undefined,
      rawLevel,
      hasDirective: match !== null,
    } as NamedLevelDirective<T, Field>;
  };
}

export const extractThinkDirective = createLevelDirectiveExtractor(
  ["thinking", "think", "t"],
  "thinkLevel",
  normalizeThinkLevel,
);
export const extractVerboseDirective = createLevelDirectiveExtractor(
  ["verbose", "v"],
  "verboseLevel",
  normalizeVerboseLevel,
);
export const extractTraceDirective = createLevelDirectiveExtractor(
  ["trace"],
  "traceLevel",
  normalizeTraceLevel,
);
export const extractFastDirective = createLevelDirectiveExtractor(
  ["fast"],
  "fastMode",
  normalizeFastMode,
);
export const extractElevatedDirective = createLevelDirectiveExtractor(
  ["elevated", "elev"],
  "elevatedLevel",
  normalizeElevatedLevel,
);
export const extractReasoningDirective = createLevelDirectiveExtractor(
  ["reasoning", "reason"],
  "reasoningLevel",
  normalizeReasoningLevel,
);

const TEMPERATURE_DIRECTIVE_PATTERN = compileDirectivePattern(["temperature", "temp"]);

/**
 * Extracts the numeric /temperature directive. Unlike level directives the
 * argument is a number (0–2), so the token scan consumes digits, dots, and
 * minus signs in addition to letters.
 */
export function extractTemperatureDirective(
  body?: string,
  options?: LevelDirectiveParseOptions,
): {
  cleaned: string;
  temperature?: number;
  rawTemperature?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }
  const match = body.match(TEMPERATURE_DIRECTIVE_PATTERN);
  if (!match || match.index === undefined) {
    return { cleaned: body, hasDirective: false };
  }
  const start = match.index;
  let i = match.index + match[0].length;
  while (i < body.length && /\s/.test(body.charAt(i))) {
    i += 1;
  }
  if (body[i] === ":") {
    i += 1;
    while (i < body.length && /\s/.test(body.charAt(i))) {
      i += 1;
    }
  }
  const argStart = i;
  while (
    i < body.length &&
    (options?.strict ? !/\s/.test(body.charAt(i)) : /[0-9.\-A-Za-z]/.test(body.charAt(i)))
  ) {
    i += 1;
  }
  const candidate = i > argStart ? body.slice(argStart, i) : undefined;
  if (
    candidate !== undefined &&
    (options?.strict ||
      normalizeTemperature(candidate) !== undefined ||
      body.slice(i).trim().length === 0)
  ) {
    const cleaned = `${body.slice(0, start)} ${body.slice(i)}`.replace(/\s+/g, " ").trim();
    return {
      cleaned,
      temperature: normalizeTemperature(candidate),
      rawTemperature: candidate,
      hasDirective: true,
    };
  }
  const cleaned = `${body.slice(0, start)} ${body.slice(argStart)}`.replace(/\s+/g, " ").trim();
  return { cleaned, hasDirective: true };
}

export type { ElevatedLevel, ReasoningLevel, ThinkLevel, TraceLevel, VerboseLevel };
export { extractExecDirective } from "./exec/directive.js";
export { extractStatusDirective } from "./reply-inline.js";
