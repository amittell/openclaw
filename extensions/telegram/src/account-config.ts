// Telegram helper module supports account config behavior.
import {
  mergeAccountConfig,
  normalizeAccountId,
  resolveNormalizedAccountEntry,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";

export function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig | undefined {
  const normalized = normalizeAccountId(accountId);
  return resolveNormalizedAccountEntry(
    cfg.channels?.telegram?.accounts,
    normalized,
    normalizeAccountId,
  );
}

export function mergeTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const channelConfig = cfg.channels?.telegram;
  // Empty groups retain their shipped single-account inheritance behavior;
  // multiple accounts can explicitly opt out with an empty map.
  const isMultiAccount = Object.keys(channelConfig?.accounts ?? {}).length > 1;
  const accountConfig = resolveTelegramAccountConfig(cfg, accountId);
  const merged = mergeAccountConfig<TelegramAccountConfig>({
    channelConfig,
    accountConfig,
    omitKeys: ["defaultAccount"],
    inheritEmptyKeys: { capabilities: "array", ...(isMultiAccount ? {} : { groups: "object" }) },
    preserveRootAllowFrom: true,
  });
  // botLoopProtection layers key by key, matching every other channel: an account
  // overrides one budget knob without inheriting the channel block verbatim, and a
  // shallow spread would let an explicit `undefined` erase a channel-level value.
  const botLoopProtection = mergePairLoopGuardConfig(
    channelConfig?.botLoopProtection,
    accountConfig?.botLoopProtection,
  );
  return {
    ...merged,
    ...(botLoopProtection ? { botLoopProtection } : {}),
  };
}
