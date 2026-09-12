// Telegram plugin module implements update offset store behavior.
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import {
  fingerprintTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const STORE_VERSION = 4;
export const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
export const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

type TelegramUpdateOffsetState = {
  version: number;
  lastUpdateId: number | null;
  botId: string | null;
  tokenFingerprint: string | null;
  /** Bot API root the offset was confirmed against; update ids are scoped to one server. */
  apiRoot: string | null;
};

type TelegramUpdateOffsetStore = PluginStateKeyedStore<TelegramUpdateOffsetState>;

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeTelegramUpdateOffsetAccountId(accountId?: string) {
  return normalizeTelegramStateAccountId(accountId);
}

function openUpdateOffsetStore(env?: NodeJS.ProcessEnv): TelegramUpdateOffsetStore {
  return getTelegramRuntime().state.openKeyedStore<TelegramUpdateOffsetState>({
    namespace: TELEGRAM_UPDATE_OFFSET_NAMESPACE,
    maxEntries: TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function extractBotIdFromToken(token?: string): string | null {
  const botUserId = resolveTelegramBotUserIdFromToken(token);
  return botUserId === undefined ? null : String(botUserId);
}

function fingerprintFromToken(token?: string): string | null {
  const trimmed = token?.trim();
  if (!trimmed) {
    return null;
  }
  return fingerprintTelegramBotToken(trimmed);
}

function safeParseState(parsed: unknown): TelegramUpdateOffsetState | null {
  try {
    const state = parsed as {
      version?: number;
      lastUpdateId?: number | null;
      botId?: string | null;
      tokenFingerprint?: string | null;
      apiRoot?: string | null;
    };
    if (
      typeof state?.version !== "number" ||
      !Number.isInteger(state.version) ||
      state.version < 1 ||
      state.version > STORE_VERSION
    ) {
      return null;
    }
    if (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) {
      return null;
    }
    if (state.version >= 2 && state.botId !== null && typeof state.botId !== "string") {
      return null;
    }
    if (
      state.version >= 3 &&
      state.tokenFingerprint !== null &&
      typeof state.tokenFingerprint !== "string"
    ) {
      return null;
    }
    if (state.version >= 4 && state.apiRoot !== null && typeof state.apiRoot !== "string") {
      return null;
    }
    return {
      version: state.version,
      lastUpdateId: state.lastUpdateId ?? null,
      botId: state.version >= 2 ? (state.botId ?? null) : null,
      tokenFingerprint: state.version >= 3 ? (state.tokenFingerprint ?? null) : null,
      apiRoot: state.version >= 4 ? (state.apiRoot ?? null) : null,
    };
  } catch {
    return null;
  }
}

export type TelegramOffsetRotationReason =
  | "bot-id-changed"
  | "token-rotated"
  | "legacy-state"
  | "api-root-changed";

export type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
  /** Only meaningful for "api-root-changed"; null when the stored offset predates root tracking. */
  previousApiRoot: string | null;
  currentApiRoot: string | null;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
  apiRoot?: string,
): TelegramUpdateOffsetRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId || parsed.lastUpdateId === null) {
    return null;
  }
  // Offsets written before root tracking (v3 and older) all came from the cloud API.
  const currentApiRoot = apiRoot === undefined ? null : normalizeTelegramApiRoot(apiRoot);
  const storedApiRoot = parsed.apiRoot ?? normalizeTelegramApiRoot();
  let reason: TelegramOffsetRotationReason | null = null;
  if (parsed.botId === null) {
    reason = "legacy-state";
  } else if (parsed.botId !== currentBotId) {
    reason = "bot-id-changed";
  } else if (parsed.tokenFingerprint === null) {
    reason = "legacy-state";
  } else if (parsed.tokenFingerprint !== fingerprintFromToken(botToken)) {
    reason = "token-rotated";
  } else if (currentApiRoot !== null && storedApiRoot !== currentApiRoot) {
    // update_id sequences belong to one Bot API server. A local server answers a
    // cloud offset by replaying its queue head, which loops forever (see worker).
    reason = "api-root-changed";
  }
  return reason
    ? {
        reason,
        previousBotId: parsed.botId,
        currentBotId,
        staleLastUpdateId: parsed.lastUpdateId,
        previousApiRoot: parsed.apiRoot,
        currentApiRoot,
      }
    : null;
}

export async function readTelegramUpdateOffset(params: {
  accountId?: string;
  botToken?: string;
  apiRoot?: string;
  env?: NodeJS.ProcessEnv;
  onRotationDetected?: (info: TelegramUpdateOffsetRotationInfo) => void | Promise<void>;
}): Promise<number | null> {
  const key = normalizeTelegramUpdateOffsetAccountId(params.accountId);
  let storedValue: unknown;
  try {
    storedValue = await openUpdateOffsetStore(params.env).lookup(key);
  } catch {
    storedValue = undefined;
  }
  const parsed = safeParseState(storedValue);
  if (!parsed) {
    return null;
  }
  const rotation = rotationForToken(parsed, params.botToken, params.apiRoot);
  if (rotation) {
    await params.onRotationDetected?.(rotation);
    return null;
  }
  return parsed.lastUpdateId;
}

export async function writeTelegramUpdateOffset(params: {
  accountId?: string;
  updateId: number;
  botToken?: string;
  apiRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!isValidUpdateId(params.updateId)) {
    throw new Error("Telegram update offset must be a non-negative safe integer.");
  }
  const payload: TelegramUpdateOffsetState = {
    version: STORE_VERSION,
    lastUpdateId: params.updateId,
    botId: extractBotIdFromToken(params.botToken),
    tokenFingerprint: fingerprintFromToken(params.botToken),
    apiRoot: normalizeTelegramApiRoot(params.apiRoot),
  };
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await openUpdateOffsetStore(params.env).delete(
    normalizeTelegramUpdateOffsetAccountId(params.accountId),
  );
}

export async function listTelegramLegacyUpdateOffsetEntries(params: {
  accountId?: string;
  persistedPath: string;
}): Promise<Array<{ key: string; value: TelegramUpdateOffsetState }>> {
  const { value } = await readJsonFileWithFallback<unknown>(params.persistedPath, null);
  const parsed = safeParseState(value);
  if (!parsed || parsed.lastUpdateId === null) {
    return [];
  }
  return [{ key: normalizeTelegramUpdateOffsetAccountId(params.accountId), value: parsed }];
}

export function shouldReplaceTelegramUpdateOffsetEntry(params: {
  existingValue: unknown;
  incomingValue: unknown;
  botToken?: string;
}): boolean {
  const existing = safeParseState(params.existingValue);
  const incoming = safeParseState(params.incomingValue);
  if (!incoming || incoming.lastUpdateId === null) {
    return false;
  }
  if (!existing || existing.lastUpdateId === null) {
    return true;
  }
  if (!params.botToken) {
    if (existing.botId && incoming.botId && existing.botId !== incoming.botId) {
      return false;
    }
    if (
      existing.tokenFingerprint &&
      incoming.tokenFingerprint &&
      existing.tokenFingerprint !== incoming.tokenFingerprint
    ) {
      return false;
    }
  }
  const incomingRotation = rotationForToken(incoming, params.botToken);
  if (incomingRotation) {
    return false;
  }
  const existingRotation = rotationForToken(existing, params.botToken);
  if (existingRotation) {
    return true;
  }
  return incoming.lastUpdateId > existing.lastUpdateId;
}
