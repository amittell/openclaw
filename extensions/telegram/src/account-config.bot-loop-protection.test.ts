import type { OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import { describe, expect, it } from "vitest";
import { mergeTelegramAccountConfig } from "./account-config.js";

// Telegram was the only channel that did not layer botLoopProtection per account:
// clickclack and googlechat both call mergePairLoopGuardConfig, Telegram relied on
// the generic shallow spread. These pin the layering that closes that gap.
function cfgWith(channel: unknown, account: unknown): OpenClawConfig {
  return {
    channels: {
      telegram: {
        ...(channel ? { botLoopProtection: channel } : {}),
        accounts: { main: { ...(account ? { botLoopProtection: account } : {}) } },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("mergeTelegramAccountConfig botLoopProtection", () => {
  it("layers an account override field-by-field over the channel block", () => {
    const merged = mergeTelegramAccountConfig(
      cfgWith(
        { enabled: true, maxEventsPerWindow: 8, windowSeconds: 120, cooldownSeconds: 30 },
        { maxEventsPerWindow: 2 },
      ),
      "main",
    );
    // Without layering, the account object replaces the channel block wholesale and
    // windowSeconds/cooldownSeconds/enabled are lost.
    expect(merged.botLoopProtection).toEqual({
      enabled: true,
      maxEventsPerWindow: 2,
      windowSeconds: 120,
      cooldownSeconds: 30,
    });
  });

  it("does not let an explicit undefined on the account erase a channel value", () => {
    const merged = mergeTelegramAccountConfig(
      cfgWith({ enabled: false, windowSeconds: 90 }, { windowSeconds: undefined }),
      "main",
    );
    expect(merged.botLoopProtection).toEqual({ enabled: false, windowSeconds: 90 });
  });

  it("inherits the channel block when the account declares none", () => {
    const merged = mergeTelegramAccountConfig(
      cfgWith({ enabled: true, windowSeconds: 60 }, null),
      "main",
    );
    expect(merged.botLoopProtection).toEqual({ enabled: true, windowSeconds: 60 });
  });

  it("stays undefined when neither level configures it", () => {
    expect(
      mergeTelegramAccountConfig(cfgWith(null, null), "main").botLoopProtection,
    ).toBeUndefined();
  });
});
