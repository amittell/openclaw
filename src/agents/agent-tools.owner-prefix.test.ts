/**
 * Prompt-prefix identity across senders: a non-owner turn (for example a subagent
 * completion dispatched with a synthetic system client) must send the same tool
 * declarations and the same stable system-prompt prefix as an owner turn of the
 * same session, so provider prompt caches survive the sender switch.
 */
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { beforeEach, describe, expect, it } from "vitest";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { listOwnerOnlyToolStubNames } from "./owner-only-tool-stub-marker.js";
import { buildOwnerOnlyToolsUnavailablePrompt } from "./owner-only-tool-stubs.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

const sessionKey = "agent:main:telegram:direct:owner";

function buildTurn(senderIsOwner: boolean) {
  const tools = createOpenClawCodingTools({
    sessionKey,
    runId: senderIsOwner ? "owner-run" : "completion-run",
    messageProvider: "telegram",
    senderId: senderIsOwner ? "owner" : undefined,
    senderIsOwner,
    workspaceDir: "/tmp/owner-prefix-workspace",
    agentDir: "/tmp/owner-prefix-agent",
  });
  const declarations = tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir: "/tmp/owner-prefix-workspace",
    toolNames: tools.map((tool) => tool.name),
    // The embedded attempt puts this per-turn note in the volatile Conversation Context.
    extraSystemPrompt: buildOwnerOnlyToolsUnavailablePrompt(listOwnerOnlyToolStubNames(tools)),
    ownerNumbers: senderIsOwner ? ["owner"] : [],
    runtimeInfo: { agentId: "main", sessionKey, sessionId: "session-1" },
  });
  return { declarations, systemPrompt };
}

function splitAtBoundary(systemPrompt: string): { prefix: string; suffix: string } {
  const boundary = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  expect(boundary).toBeGreaterThan(0);
  return { prefix: systemPrompt.slice(0, boundary), suffix: systemPrompt.slice(boundary) };
}

describe("owner and non-owner turns of one session", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("send identical tool declarations and an identical stable prompt prefix", () => {
    const owner = buildTurn(true);
    const completion = buildTurn(false);

    expect(owner.declarations.map((tool) => tool.name)).toContain("gateway");
    expect(JSON.stringify(completion.declarations)).toBe(JSON.stringify(owner.declarations));
    const ownerPrompt = splitAtBoundary(owner.systemPrompt);
    const completionPrompt = splitAtBoundary(completion.systemPrompt);
    expect(completionPrompt.prefix).toBe(ownerPrompt.prefix);
    // Only the per-turn suffix says which declared tools refuse for this sender.
    const refusalLine =
      "Owner-only tools unavailable on this turn; calls to them are refused: " +
      "`nodes`, `automations`, `gateway`, `openclaw`, `conversations_list`, " +
      "`conversations_send`, `conversations_turn`.";
    expect(completionPrompt.suffix).toContain(refusalLine);
    expect(ownerPrompt.suffix).not.toContain("Owner-only tools unavailable");
  });
});
