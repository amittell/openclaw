import { describe, expect, it, vi } from "vitest";
import type { FailoverReason } from "./signal.js";

const hoisted = vi.hoisted(() => ({
  classifyProviderFailoverSignalWithPlugin: vi.fn((): FailoverReason | null => null),
}));
vi.mock("../../plugins/provider-failover.js", () => hoisted);

import { classifyProviderRuntimeFailureKind } from "../embedded-agent-helpers/provider-runtime-failure.js";
import { isContextOverflowError } from "./classify.js";
import { isLikelyHttpErrorText, renderSanitizedUserFacingText } from "./user-copy.js";

it("renders task results and HTTP errors without activating provider hooks", () => {
  hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();
  expect(renderSanitizedUserFacingText("Audit complete.", { errorContext: true })).toBe(
    "Audit complete.",
  );
  expect(isLikelyHttpErrorText("500 Internal Server Error")).toBe(true);
  expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

it("skips provider hooks for unrelated context-overflow candidates", () => {
  hoisted.classifyProviderFailoverSignalWithPlugin.mockClear();
  expect(isContextOverflowError("Permission denied for /root/oc-acp-write-should-fail.txt.")).toBe(
    false,
  );
  expect(hoisted.classifyProviderFailoverSignalWithPlugin).not.toHaveBeenCalled();
});

<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
=======
it.each(["ValidationException: The input is too long for the model", "context length exceeded"])(
  "recognizes context overflow: %s",
  (message) => {
    expect(isContextOverflowError(message)).toBe(true);
  },
);

it("detects Hugging Face TGI input validation overflow", () => {
  // TGI wraps router/src/validation.rs errors as "Input validation error: ..." with HTTP 422.
  const tgi = (message: string) => `422 Input validation error: ${message}`;
  expect(
    isContextOverflowError(
      tgi(
        "`inputs` tokens + `max_new_tokens` must be <= 32768. Given: 28897 `inputs` tokens and 3872 `max_new_tokens`",
      ),
    ),
  ).toBe(true);
  expect(
    isContextOverflowError(tgi("`inputs` must have less than 32768 tokens. Given: 40000")),
  ).toBe(true);
  expect(isContextOverflowError(tgi("`max_new_tokens` must be <= 4096. Given: 8192"))).toBe(false);
});

it("recognizes a deactivated model", () => {
  expect(classifyFailoverReason("model_is_deactivated: this model has been deactivated")).toBe(
    "model_not_found",
  );
});

it("prefers xAI billing evidence over resource-exhausted rate limits", () => {
  expect(
    classifyFailoverReason(
      '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      { provider: "xai" },
    ),
  ).toBe("billing");
});

>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("CDN HTML classification", () => {
  it.each([
    { status: 502, body: "Bad Gateway", kind: "upstream_html" },
    { status: 403, body: "Enable JavaScript and cookies to continue.", kind: "upstream_html" },
    { status: 403, body: "Forbidden", kind: "auth_html" },
  ])("distinguishes $status $body at the runtime boundary", ({ status, body, kind }) => {
    expect(classifyProviderRuntimeFailureKind({ status, message: html(body) })).toBe(kind);
  });

  it("recognizes an Error-prefixed proxy response", () => {
    expect(
      classifyProviderRuntimeFailureKind(`Error: 407 ${html("Proxy Authentication Required")}`),
    ).toBe("proxy");
  });
});
