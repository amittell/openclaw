import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import * as sessions from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
import { withTempHomeCore } from "../plugin-sdk/test-helpers/temp-home.js";

export async function withAgentCommandTestHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeCore(fn, { prefix: "openclaw-agent-" });
}

export function createDefaultAgentResult(params?: {
  payloads?: Array<Record<string, unknown>>;
  durationMs?: number;
  sessionId?: string;
  provider?: string;
  model?: string;
}) {
  const {
    payloads = [{ text: "ok" }],
    durationMs = 5,
    sessionId = "s",
    provider = "p",
    model = "m",
  } = params ?? {};
  const agentMeta = { sessionId, provider, model };
  return { payloads, meta: { durationMs, agentMeta } };
}

export async function useRealCommandSessionPersistence(): Promise<void> {
  const [{ updateSessionStoreAfterAgentRun: update }, runtime] = await Promise.all([
    import("../agents/command/session-store.js"),
    import("../agents/command/session-store.runtime.js"),
  ]);
  const persistence = vi
    .spyOn(runtime, "updateSessionStoreAfterAgentRun")
    .mockImplementation(update);
  onTestFinished(() => persistence.mockRestore());
}

export async function writeSessionStoreSeed(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : sessionKey;
    await sessions.replaceSessionEntry({ sessionKey, storePath }, {
      ...entry,
      sessionId,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    } as SessionEntry);
  }
}

export function readSessionStore<T>(storePath: string): Record<string, T> {
  return Object.fromEntries(
    sessions
      .listSessionEntriesCore({ storePath })
      .map(({ entry, sessionKey: key }) => [key, entry as T]),
  );
}

export function expectOwnedCommandSession(
  params: Record<
    "agentId" | "excludedAgentId" | "sessionKey" | "sessionId" | "storePath",
    string
  > & {
    /** The model the run asked for; defaults to agent.test.ts's configured primary. */
    modelProvider?: string;
    model?: string;
  },
): void {
  const load = (agentId: string) =>
    sessions.loadSessionEntryReadOnly({
      agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
  const entry = load(params.agentId);
  // The carry persists a run's model only when it is the model the run asked for; a fallback
  // stays transient (session-store.ts isFromFallback). Callers' mocked runs report the
  // requested model, so the entry records the configured primary.
  expect(entry).toMatchObject({
    sessionId: params.sessionId,
    model: params.model ?? "claude-opus-4-6",
    modelProvider: params.modelProvider ?? "anthropic",
  });
  expect(load(params.excludedAgentId)).toBeUndefined();
}

export function createOutboundSessionRouteFixture(
  params: Parameters<typeof buildOutboundBaseSessionKey>[0] &
    Record<"from" | "to", string> & {
      chatType: "direct" | "group" | "channel";
    },
) {
  const baseSessionKey = buildOutboundBaseSessionKey(params);
  const { peer, chatType, from, to } = params;
  return { sessionKey: baseSessionKey, baseSessionKey, peer, chatType, from, to };
}
