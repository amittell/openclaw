// Telegram tests cover request timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveTelegramLongPollTimeoutSeconds,
  resolveTelegramMediaUploadTimeoutMs,
  resolveTelegramRequestTimeoutMs,
  resolveTelegramStartupProbeTimeoutMs,
} from "./request-timeouts.js";

describe("resolveTelegramRequestTimeoutMs", () => {
  it("bounds Telegram startup control-plane methods", () => {
    expect(resolveTelegramRequestTimeoutMs("deletemycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("deletewebhook")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("getme")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setmycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setwebhook")).toBe(15_000);
  });

  it("keeps the longer polling timeout for getUpdates", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates")).toBe(45_000);
  });

  it("bounds outbound delivery methods", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendmessagedraft")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("sendphoto")).toBe(30_000);
  });

  it("honors higher configured timeoutSeconds except for long polling", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("getupdates", 90)).toBe(45_000);
  });

  it("caps oversized configured timeoutSeconds before outbound timers use them", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveTelegramRequestTimeoutMs("sendmessage", Number.MAX_VALUE)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("does not let low timeoutSeconds shorten method guards", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 10)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("getme", 10)).toBe(15_000);
  });

  it("uses the outbound guard for unlisted Telegram methods", () => {
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery", 10)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery", 90)).toBe(90_000);
  });

  it("does not assign a timeout when no Telegram method can be identified", () => {
    expect(resolveTelegramRequestTimeoutMs(null)).toBeUndefined();
  });

  it("scales media upload timeouts with the outgoing file size", () => {
    const mb = 1024 * 1024;
    // 10MB @ 2MB/s = 5s upload + 60s margin = 65s
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 10 * mb)).toBe(65_000);
    // 100MB @ 2MB/s = 50s upload + 60s margin = 110s
    expect(resolveTelegramRequestTimeoutMs("senddocument", undefined, 100 * mb)).toBe(110_000);
    // 100MB photo, same size-aware guard
    expect(resolveTelegramRequestTimeoutMs("sendphoto", undefined, 100 * mb)).toBe(110_000);
    expect(resolveTelegramRequestTimeoutMs("sendanimation", undefined, 100 * mb)).toBe(110_000);
    expect(resolveTelegramRequestTimeoutMs("sendaudio", undefined, 100 * mb)).toBe(110_000);
    expect(resolveTelegramRequestTimeoutMs("sendvoice", undefined, 100 * mb)).toBe(110_000);
  });

  it("keeps the 30s floor when the media size is unknown", () => {
    expect(resolveTelegramRequestTimeoutMs("sendvideo")).toBe(30_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, undefined)).toBe(30_000);
  });

  it("caps media upload timeouts at the 3600s ceiling", () => {
    const gb = 1024 * 1024 * 1024;
    // 8GB @ 2MB/s = 4096s upload + 60s margin = 4156s -> clamped to 3600s
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 8 * gb)).toBe(3_600_000);
  });

  it("lets a higher configured timeoutSeconds still win for media uploads", () => {
    const mb = 1024 * 1024;
    // 1MB size-aware = 61s, but configured 90s is higher
    expect(resolveTelegramRequestTimeoutMs("sendvideo", 90, 1 * mb)).toBe(90_000);
  });

  it("lets the size-aware floor dominate a low configured timeoutSeconds", () => {
    const mb = 1024 * 1024;
    // 100MB size-aware = 110s, configured 10s is lower
    expect(resolveTelegramRequestTimeoutMs("senddocument", 10, 100 * mb)).toBe(110_000);
  });

  it("ignores file size for non-media upload methods", () => {
    const mb = 1024 * 1024;
    // sendmessage is not a media upload; size must not change its guard
    expect(resolveTelegramRequestTimeoutMs("sendmessage", undefined, 100 * mb)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext", undefined, 100 * mb)).toBe(15_000);
  });

  it("keeps the long-poll guard unchanged regardless of file size", () => {
    const gb = 1024 * 1024 * 1024;
    expect(resolveTelegramRequestTimeoutMs("getupdates")).toBe(45_000);
    expect(resolveTelegramRequestTimeoutMs("getupdates", 90)).toBe(45_000);
    expect(resolveTelegramRequestTimeoutMs("getupdates", undefined, 8 * gb)).toBe(45_000);
  });
});

describe("resolveTelegramMediaUploadTimeoutMs", () => {
  it("returns the 30s floor when no size is known", () => {
    expect(resolveTelegramMediaUploadTimeoutMs(undefined)).toBe(30_000);
  });

  it("scales a known size at 2MB/s plus a 60s margin", () => {
    const mb = 1024 * 1024;
    // 1MB -> ceil(0.5)=1s + 60s = 61s
    expect(resolveTelegramMediaUploadTimeoutMs(1 * mb)).toBe(61_000);
    // 50MB -> 25s + 60s = 85s
    expect(resolveTelegramMediaUploadTimeoutMs(50 * mb)).toBe(85_000);
  });

  it("rounds the upload estimate up to the next second", () => {
    const mb = 1024 * 1024;
    // 10MB -> exactly 5s -> 5s + 60s = 65s
    expect(resolveTelegramMediaUploadTimeoutMs(10 * mb)).toBe(65_000);
    // 10MB + 1 byte -> ceil(5.0000005)=6s -> 6s + 60s = 66s
    expect(resolveTelegramMediaUploadTimeoutMs(10 * mb + 1)).toBe(66_000);
  });

  it("clamps large sizes to the 3600s ceiling", () => {
    const gb = 1024 * 1024 * 1024;
    expect(resolveTelegramMediaUploadTimeoutMs(8 * gb)).toBe(3_600_000);
    expect(resolveTelegramMediaUploadTimeoutMs(1024 * gb)).toBe(3_600_000);
  });
});

describe("resolveTelegramLongPollTimeoutSeconds", () => {
  it("uses Telegram's default long-poll duration when no client timeout is configured", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(undefined)).toBe(30);
  });

  it("keeps isolated long polling below the getUpdates request abort guard", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(90)).toBe(40);
  });

  it("honors lower configured long-poll durations", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(10)).toBe(10);
  });
});

describe("resolveTelegramStartupProbeTimeoutMs", () => {
  it("uses the getMe request guard by default", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(undefined)).toBe(15_000);
  });

  it("does not let low client timeoutSeconds shorten startup getMe", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(2)).toBe(15_000);
  });

  it("honors higher configured timeoutSeconds", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(60)).toBe(60_000);
  });

  it("caps oversized configured timeoutSeconds before startup probe timers use them", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveTelegramStartupProbeTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
