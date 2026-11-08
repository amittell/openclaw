import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  extractCompactionMessageText as extractMessageText,
  formatCompactionUserLabel,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import type { AgentMessage } from "../runtime/index.js";

const MAX_RECENT_TURN_TEXT_CHARS = 600;
const MAX_PRESERVED_TOOL_RESULT_CHARS = 160;

function formatNonTextPlaceholder(content: unknown): string | null {
  if (content == null || typeof content === "string") {
    return null;
  }
  if (!Array.isArray(content)) {
    return "[non-text content]";
  }
  const typeCounts = new Map<string, number>();
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const typeRaw = "type" in block ? block.type : undefined;
    const type = typeof typeRaw === "string" && typeRaw.trim().length > 0 ? typeRaw : "unknown";
    if (type === "text") {
      continue;
    }
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  return typeCounts.size > 0
    ? `[non-text content: ${Array.from(typeCounts, ([type, count]) =>
        count > 1 ? `${type} x${count}` : type,
      ).join(", ")}]`
    : null;
}

export function formatContextMessage(message: AgentMessage): string | null {
  let roleLabel: string;
  if (message.role === "assistant") {
    roleLabel = "Assistant";
  } else if (message.role === "user") {
    roleLabel = formatCompactionUserLabel(message);
  } else if (message.role === "toolResult") {
    const toolName = message.toolName;
    const safeToolName = typeof toolName === "string" && toolName.trim() ? toolName : "tool";
    roleLabel = `Tool result (${safeToolName})`;
  } else {
    return null;
  }
  const rendered = [extractMessageText(message), formatNonTextPlaceholder(message.content)]
    .filter(Boolean)
    .join("\n");
  if (!rendered) {
    return null;
  }
  // Tool output is bulk the summary already distills; keep only a head excerpt
  // so it cannot crowd generated facts out of the bounded artifact.
  const limit =
    message.role === "toolResult" ? MAX_PRESERVED_TOOL_RESULT_CHARS : MAX_RECENT_TURN_TEXT_CHARS;
  const trimmed =
    rendered.length <= limit
      ? rendered
      : message.role === "toolResult"
        ? `${truncateUtf16Safe(rendered, limit)} [${rendered.length - limit} more chars omitted at compaction]`
        : `${truncateUtf16Safe(rendered, limit)}...`;
  return `- ${roleLabel}: ${trimmed}`;
}
