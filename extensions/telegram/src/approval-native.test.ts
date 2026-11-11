import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeSessionDeliveryState,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

// The capability is built while the module loads; record SDK warnings from that import.
const emitWarning = vi.hoisted(() => vi.spyOn(process, "emitWarning"));
const loadDeprecations = emitWarning.mock.calls
  .filter(([, options]) => typeof options === "object" && options.code === "DEP_PLUGIN_SDK")
  .map(([message]) => String(message));
emitWarning.mockRestore();

function buildConfig(
  overrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
): OpenClawConfig {
  return {
    channels: {
      telegram: {
        botToken: "tok",
        execApprovals: {
          enabled: true,
          approvers: ["8460800771"],
          target: "dm",
        },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-telegram-approval-native-");

function createTempStorePath(): string {
  const dir = sessionDirs.make();
  return path.join(dir, "sessions.json");
}

async function writeSessionEntry(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  await upsertSessionEntry(params);
}

describe("telegram native approval adapter", () => {
  it("builds the approval capability without deprecated Plugin SDK factories", async () => {
    expect(loadDeprecations).toEqual([]);
    const cfg = buildConfig();
    const authorize = async (senderId: string) =>
      (
        await telegramApprovalCapability.authorizeActorActionAsync?.({
          cfg,
          accountId: "default",
          senderId,
          action: "approve",
          approvalKind: "exec",
        })
      )?.authorized;
    expect(await authorize("8460800771")).toBe(true);
    expect(await authorize("1234")).toBe(false);
    expect(
      await telegramApprovalCapability.nativeAsync?.describeDeliveryCapabilities({
        cfg,
        accountId: "default",
        approvalKind: "exec",
        request: {
          id: "req-0",
          request: { command: "echo hi" },
          createdAtMs: 0,
          expiresAtMs: 1000,
        },
      }),
    ).toEqual({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: true,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly: true,
    });
  });

  it.each([undefined, "work"])(
    "reserves terminal UI recovery for plugin approvals on account %s",
    (accountId) => {
      const params = { channel: "telegram", channelLabel: "Telegram", accountId };
      const execText = telegramApprovalCapability.describeExecApprovalSetup?.(params);
      const pluginText = telegramApprovalCapability.describePluginApprovalSetup?.(params);
      const prefix = accountId ? `channels.telegram.accounts.${accountId}` : "channels.telegram";

      expect(execText).toContain("Approve it from the Web UI for now.");
      expect(execText).not.toMatch(/terminal UI|\bTUI\b/i);
      expect(pluginText).toContain("Approve it from the Web UI or terminal UI for now.");
      expect(pluginText).toContain("Telegram supports native plugin approvals");
      expect(execText).toContain(`\`${prefix}.execApprovals.approvers\``);
      expect(pluginText).toContain(`\`${prefix}.execApprovals.approvers\``);
    },
  );

  it("normalizes direct-chat origin targets so DM dedupe can converge", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:8460800771",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:direct:8460800771",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "8460800771",
      threadId: undefined,
    });
  });

  it("parses topic-scoped turn-source targets in the extension", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "exec",
      request: {
        id: "req-topic-1",
        request: {
          command: "echo hi",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:topic:928",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });

  it("preserves channel Direct Messages topic targets from the turn source", async () => {
    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: buildConfig(),
      accountId: "default",
      approvalKind: "system-agent",
      request: {
        id: "req-direct-topic-1",
        request: {
          command: "set config gateway.port 19001",
          turnSourceChannel: "telegram",
          turnSourceTo: "telegram:-1003841603622:direct-topic:77",
          turnSourceAccountId: "default",
          sessionKey: "agent:main:telegram:group:-1003841603622:direct-topic:77",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622:direct-topic:77",
      threadId: undefined,
    });
  });

  it("parses numeric string thread ids from the session store for plugin approvals", async () => {
    const storePath = createTempStorePath();
    await writeSessionEntry({
      storePath,
      sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
      entry: {
        sessionId: "sess",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({
          context: {
            channel: "telegram",
            to: "-1003841603622",
            accountId: "default",
            threadId: "928",
          },
        }),
      },
    });

    const target = await telegramApprovalCapability.nativeAsync?.resolveOriginTarget?.({
      cfg: {
        ...buildConfig(),
        session: { store: storePath },
      },
      accountId: "default",
      approvalKind: "plugin",
      request: {
        id: "plugin:req-2",
        request: {
          title: "Plugin approval",
          description: "Allow access",
          sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
        },
        createdAtMs: 0,
        expiresAtMs: 1000,
      },
    });

    expect(target).toEqual({
      to: "-1003841603622",
      threadId: 928,
    });
  });
});
