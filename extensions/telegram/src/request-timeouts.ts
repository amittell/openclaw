// Telegram plugin module implements request timeouts behavior.
import {
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
} from "openclaw/plugin-sdk/number-runtime";

export const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45_000;
const TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 30;
const TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS = 5;
// Size-aware media upload timeouts. Local uploads through the self-hosted Bot
// API run at roughly 3MB/s, so a fixed 30s guard aborts large files mid-upload
// (the tdlib upload keeps going in the background and delivers minutes later,
// producing a false failure plus duplicate retries). Scale the guard with the
// outgoing file size at a conservative 2MB/s plus a fixed margin, clamped to a
// 30s floor and a 3600s ceiling (or the timer cap if that is lower).
const TELEGRAM_MEDIA_UPLOAD_RATE_BYTES_PER_SECOND = 2 * 1024 * 1024;
const TELEGRAM_MEDIA_UPLOAD_FIXED_MARGIN_MS = 60_000;
const TELEGRAM_MEDIA_UPLOAD_TIMEOUT_FLOOR_MS = 30_000;
const TELEGRAM_MEDIA_UPLOAD_TIMEOUT_CEILING_MS = 3_600_000;
// grammY races every API call against one client-wide timer (500 s unless
// client.timeoutSeconds is set) and has no per-call override, and undici waits
// 300 s for response headers after the request body. Clients that install
// createTelegramClientFetch set both past the upload ceiling, so the per-method
// guard decides: 45 s for getUpdates, up to the ceiling for media uploads.
export const TELEGRAM_CLIENT_TIMEOUT_BACKSTOP_SECONDS =
  TELEGRAM_MEDIA_UPLOAD_TIMEOUT_CEILING_MS / 1000 + 60;
const TELEGRAM_MEDIA_UPLOAD_METHODS = new Set([
  "sendanimation",
  "sendaudio",
  "senddocument",
  "sendphoto",
  "sendvideo",
  "sendvoice",
]);

function isTelegramMediaUploadMethod(method: string): boolean {
  return TELEGRAM_MEDIA_UPLOAD_METHODS.has(method);
}

/**
 * Resolves the request timeout for a media upload from the outgoing file size.
 * Returns the 30s floor when the size is unknown, otherwise the size-scaled
 * duration clamped to [floor, min(ceiling, timer cap)].
 */
export function resolveTelegramMediaUploadTimeoutMs(fileSizeBytes: number | undefined): number {
  if (fileSizeBytes === undefined) {
    return TELEGRAM_MEDIA_UPLOAD_TIMEOUT_FLOOR_MS;
  }
  const uploadMs = Math.ceil(fileSizeBytes / TELEGRAM_MEDIA_UPLOAD_RATE_BYTES_PER_SECOND) * 1000;
  const ceilingMs = Math.min(TELEGRAM_MEDIA_UPLOAD_TIMEOUT_CEILING_MS, MAX_TIMER_TIMEOUT_MS);
  return Math.min(
    Math.max(
      uploadMs + TELEGRAM_MEDIA_UPLOAD_FIXED_MARGIN_MS,
      TELEGRAM_MEDIA_UPLOAD_TIMEOUT_FLOOR_MS,
    ),
    ceilingMs,
  );
}

const TELEGRAM_REQUEST_TIMEOUTS_MS = {
  // Bound startup/control-plane calls so the gateway cannot report Telegram as
  // healthy while provider startup is still hung on Bot API setup.
  deletemycommands: 15_000,
  deletewebhook: 15_000,
  deletemessage: 15_000,
  editforumtopic: 15_000,
  editmessagetext: 15_000,
  getchat: 15_000,
  getfile: 30_000,
  getme: 15_000,
  getupdates: TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
  pinchatmessage: 15_000,
  sendanimation: 30_000,
  sendaudio: 30_000,
  sendchataction: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  senddocument: 30_000,
  sendmessage: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  sendmessagedraft: TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS,
  sendphoto: 30_000,
  sendvideo: 30_000,
  sendvoice: 30_000,
  setmessagereaction: 10_000,
  setmycommands: 15_000,
  setwebhook: 15_000,
} as const;

function resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds: unknown): number | undefined {
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return undefined;
  }
  return (
    finiteSecondsToTimerSafeMilliseconds(Math.max(1, timeoutSeconds), {
      floorSeconds: true,
    }) ?? MAX_TIMER_TIMEOUT_MS
  );
}

export function resolveTelegramRequestTimeoutMs(
  method: string | null,
  timeoutSeconds?: unknown,
  fileSizeBytes?: number,
): number | undefined {
  if (!method) {
    return undefined;
  }
  if (method === "getupdates") {
    return TELEGRAM_REQUEST_TIMEOUTS_MS.getupdates;
  }
  if (isTelegramMediaUploadMethod(method)) {
    const mediaUploadTimeoutMs = resolveTelegramMediaUploadTimeoutMs(fileSizeBytes);
    return Math.max(
      mediaUploadTimeoutMs,
      resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0,
    );
  }
  const baseTimeoutMs =
    TELEGRAM_REQUEST_TIMEOUTS_MS[method as keyof typeof TELEGRAM_REQUEST_TIMEOUTS_MS] ??
    TELEGRAM_DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(baseTimeoutMs, resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0);
}

export function resolveTelegramLongPollTimeoutSeconds(timeoutSeconds: unknown): number {
  const maxLongPollTimeoutSeconds = Math.max(
    1,
    Math.floor(TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS / 1000) -
      TELEGRAM_LONG_POLL_ABORT_MARGIN_SECONDS,
  );
  const configuredTimeoutSeconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? Math.max(1, Math.floor(timeoutSeconds))
      : TELEGRAM_DEFAULT_LONG_POLL_TIMEOUT_SECONDS;
  return Math.min(configuredTimeoutSeconds, maxLongPollTimeoutSeconds);
}

export function resolveTelegramStartupProbeTimeoutMs(timeoutSeconds: unknown): number {
  const getMeTimeoutMs = resolveTelegramRequestTimeoutMs("getme") ?? 15_000;
  if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) {
    return getMeTimeoutMs;
  }
  const configuredTimeoutMs = resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 1_000;
  return Math.max(getMeTimeoutMs, configuredTimeoutMs);
}
