// Reproduces the heartbeat target-awareness re-projection defect
// (2026-09-11 repeated-relay incident): prepareHeartbeatTargetAwareness keys
// its system event on a per-execution idempotencyKey (startedAt + runSessionKey),
// so repeated heartbeat deliveries of the same content re-project
// "A heartbeat delivered this message to this channel: <content>" into the
// target session on every run. Each projection is a fresh agent turn in the
// originating conversation; the in-queue contextKey dedupe cannot catch it
// because the prior event was already drained and the key differs per run.
//
// Expected behavior (the fix): content-scoped suppression on the target
// session entry (mirrors the channel-side lastHeartbeatText 24h guard).
// A replaced target (new sessionId) never saw the prior projection and may
// re-project; a stable target session must not be re-projected with
// identical recent content.
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { buildChannelOutboundSessionRoute } from "../plugin-sdk/core.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn(
    async (request: {
      payloads?: Array<{ text?: string }>;
      onDeliveredPayload?: (payload: { text: string; mediaUrls: string[] }) => void;
    }) => {
      request.onDeliveredPayload?.({ text: request.payloads?.[0]?.text ?? "", mediaUrls: [] });
      return [{ channel: "whatsapp", messageId: "msg-1" }];
    },
  ),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
  resetSystemEventsForTest();
});

const RELAY_TEXT = "Status needs attention.";

function makeIsolatedConfig(tmpDir: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          isolatedSession: true,
        },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function installWhatsAppRoute() {
  const plugin: ChannelPlugin = {
    ...heartbeatRunnerWhatsAppPlugin,
    capabilities: {
      ...heartbeatRunnerWhatsAppPlugin.capabilities,
      chatTypes: ["direct"],
    },
    messaging: {
      ...heartbeatRunnerWhatsAppPlugin.messaging,
      targetResolver: { looksLikeId: () => true },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) =>
        buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: "whatsapp",
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: target },
          chatType: "direct",
          from: target,
          to: target,
        }),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]));
}

type AwarenessSeed = {
  lastHeartbeatAwarenessText?: string;
  lastHeartbeatAwarenessSentAt?: number;
};

describe("heartbeat target-awareness re-projection", () => {
  it("does not re-project identical delivered content into a stable target session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      installWhatsAppRoute();
      const cfg = makeIsolatedConfig(tmpDir, storePath);
      cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
      const baseSessionKey = resolveMainSessionKey(cfg);
      const target = "+15551234567";
      const targetSessionKey = `agent:main:whatsapp:direct:${target}`;
      const nowMs = Date.now();
      const delivery = {
        updatedAt: nowMs - 1_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: target,
      };

      // Base session carries the "last" delivery lane; target session is
      // stable across both runs (the live incident shape).
      await seedSessionStore(storePath, baseSessionKey, {
        ...delivery,
        sessionId: "base-session-1",
        lifecycleRevision: "lc-1",
      });
      await seedSessionStore(storePath, targetSessionKey, {
        ...delivery,
        sessionId: "target-session-1",
        lifecycleRevision: "tc-1",
      });

      const run = (at: number) =>
        runHeartbeatOnce({
          cfg,
          deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => at },
        });
      const drainTarget = () =>
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        });

      // Run 1: a successful direct delivery projects awareness into the
      // target session (existing behavior — must be preserved).
      replySpy.mockResolvedValueOnce({ text: RELAY_TEXT });
      const result1 = await run(nowMs);
      expect(result1.status).toBe("ran");
      const awareness1 = await drainTarget();
      expect(awareness1).toContain("A heartbeat delivered this message to this channel:");
      expect(awareness1).toContain(RELAY_TEXT);

      // Between runs the base delivery lane is replaced (session reset):
      // the channel-side lastHeartbeatText guard state does not carry over,
      // so run 2 legitimately delivers the same content again.
      await seedSessionStore(storePath, baseSessionKey, {
        ...delivery,
        sessionId: "base-session-2",
        lifecycleRevision: "lc-2",
        updatedAt: nowMs - 500,
      });

      // Run 2: the identical content must NOT be re-projected into the same
      // stable target session. THE DEFECT: the per-execution contextKey makes
      // the in-queue dedupe miss it, so a second awareness event is enqueued
      // and drains as a fresh agent turn in the originating conversation.
      replySpy.mockResolvedValueOnce({ text: RELAY_TEXT });
      const result2 = await run(nowMs + 600_000);
      expect(result2.status).toBe("ran");
      const awareness2 = await drainTarget();
      expect(awareness2).toBeUndefined();

      // Post-fix bookkeeping: run 1's projection recorded the content on the
      // target session entry for the repeat-run guard.
      const guard = readSessionStoreForTest<AwarenessSeed>(storePath)[targetSessionKey];
      expect(guard?.lastHeartbeatAwarenessText).toBe(RELAY_TEXT);
      expect(typeof guard?.lastHeartbeatAwarenessSentAt).toBe("number");
    });
  });
});
