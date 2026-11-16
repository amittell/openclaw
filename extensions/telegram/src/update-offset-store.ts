import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { getTelegramRuntime } from "./runtime.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import {
  fingerprintOptionalTelegramBotToken,
  resolveTelegramBotUserIdFromToken,
} from "./token-fingerprint.js";

const STORE_VERSION = 4;
const TELEGRAM_UPDATE_OFFSET_NAMESPACE = "telegram.update-offsets";
const TELEGRAM_UPDATE_OFFSET_MAX_ENTRIES = 1_000;

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

function updateOffsetState(
  lastUpdateId: number | null,
  token?: string,
  apiRoot?: string,
): TelegramUpdateOffsetState {
  return {
    version: STORE_VERSION,
    lastUpdateId,
    botId: extractBotIdFromToken(token),
    tokenFingerprint: fingerprintOptionalTelegramBotToken(token),
    apiRoot: normalizeTelegramApiRoot(apiRoot),
  };
}

function safeParseState(state: unknown): TelegramUpdateOffsetState | null {
  if (!isRecord(state)) {
    return null;
  }
  if (state.version === 1 || state.version === 2) {
    throw new Error("Telegram update offsets require migration; run openclaw doctor --fix.");
  }
  // Version 3 predates Bot API root tracking (doctor's migration target); it reads as no root.
  const apiRoot = state.version === STORE_VERSION ? state.apiRoot : null;
  if (
    (state.version !== 3 && state.version !== STORE_VERSION) ||
    (state.lastUpdateId !== null && !isValidUpdateId(state.lastUpdateId)) ||
    (state.botId !== null && typeof state.botId !== "string") ||
    (state.tokenFingerprint !== null && typeof state.tokenFingerprint !== "string") ||
    (apiRoot !== null && typeof apiRoot !== "string")
  ) {
    return null;
  }
  return {
    version: state.version,
    lastUpdateId: state.lastUpdateId,
    botId: state.botId,
    tokenFingerprint: state.tokenFingerprint,
    apiRoot,
  };
}

export type TelegramOffsetRotationReason =
  | "bot-id-changed"
  | "token-rotated"
  | "legacy-state"
  | "api-root-changed";

type TelegramUpdateOffsetRotationInfo = {
  reason: TelegramOffsetRotationReason;
  previousBotId: string | null;
  currentBotId: string;
  staleLastUpdateId: number;
  /** Only meaningful for "api-root-changed"; null when the stored offset predates root tracking. */
  previousApiRoot: string | null;
  currentApiRoot: string | null;
};

export type TelegramAccountRotationInfo = Omit<
  TelegramUpdateOffsetRotationInfo,
  "staleLastUpdateId"
> & {
  staleLastUpdateId: number | null;
};

function rotationForToken(
  parsed: TelegramUpdateOffsetState,
  botToken?: string,
  apiRoot?: string,
): TelegramAccountRotationInfo | null {
  const currentBotId = extractBotIdFromToken(botToken);
  if (!currentBotId) {
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
  } else if (parsed.tokenFingerprint !== fingerprintOptionalTelegramBotToken(botToken)) {
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
  const key = normalizeTelegramStateAccountId(params.accountId);
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
    if (rotation.staleLastUpdateId !== null) {
      await params.onRotationDetected?.({
        ...rotation,
        staleLastUpdateId: rotation.staleLastUpdateId,
      });
    }
    return null;
  }
  return parsed.lastUpdateId;
}

export async function prepareTelegramAccount(params: {
  accountId: string;
  botToken: string;
  apiRoot?: string;
  abortSignal?: AbortSignal;
  onRotationDetected: (info: TelegramAccountRotationInfo) => void;
}): Promise<number | null> {
  const accountId = normalizeTelegramStateAccountId(params.accountId);
  try {
    const store = openUpdateOffsetStore();
    const parsed = safeParseState(await store.lookup(accountId));
    const rotation = parsed ? rotationForToken(parsed, params.botToken, params.apiRoot) : null;
    if (rotation) {
      params.onRotationDetected(rotation);
      if (rotation.previousBotId !== null && rotation.previousBotId !== rotation.currentBotId) {
        const queue = getTelegramRuntime().state.openChannelIngressQueue({ accountId });
        if (!queue.purge) {
          throw new Error("The host does not support ingress identity resets; update OpenClaw.");
        }
        params.abortSignal?.throwIfAborted();
        await queue.purge({ signal: params.abortSignal });
      }
    }
    params.abortSignal?.throwIfAborted();
    if (!parsed || rotation) {
      // Keep the old identity until purge commits, then replace it without an absent-marker window.
      // Webhook-only accounts need this marker even though they have no polling cursor.
      await store.register(accountId, updateOffsetState(null, params.botToken, params.apiRoot));
    }
    return rotation ? null : (parsed?.lastUpdateId ?? null);
  } catch (err) {
    throw new Error(
      `telegram: failed to prepare ingress for account "${accountId}"; restart the account to retry: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
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
  const payload = updateOffsetState(params.updateId, params.botToken, params.apiRoot);
  await openUpdateOffsetStore(params.env).register(
    normalizeTelegramStateAccountId(params.accountId),
    payload,
  );
}

export async function deleteTelegramUpdateOffset(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  await openUpdateOffsetStore(params.env).delete(normalizeTelegramStateAccountId(params.accountId));
}
