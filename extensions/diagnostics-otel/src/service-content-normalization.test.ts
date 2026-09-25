import { describe, expect, it, vi } from "vitest";

const redaction = vi.hoisted(() => ({ chars: 0 }));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    redactSensitiveText: (...args: Parameters<typeof actual.redactSensitiveText>) => {
      redaction.chars += args[0].length;
      return actual.redactSensitiveText(...args);
    },
  };
});

import { MAX_OTEL_LOG_BODY_CHARS } from "./service-constants.js";
import {
  MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
  normalizeOtelLogString,
  resolveContentCapturePolicy,
} from "./service-content-normalization.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";

const CAPTURE_ALL = resolveContentCapturePolicy(true);
const TRUNCATED_SUFFIX = "...(truncated)";
// Built at runtime so the fixtures are not literal credentials.
const SECRET_BODY = "A1b2C3d4".repeat(4);
// This token rule needs 20 characters after its prefix, more than the JSON suffix leaves.
const SECRET_TOKEN = `glpat-${SECRET_BODY}`;
// Longer than the redaction lookahead, so the END line falls outside the redacted window.
const PRIVATE_KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(250);

function captureModelCall(inputMessages: unknown[]): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  assignOtelModelContentAttributes(attributes, { inputMessages }, CAPTURE_ALL);
  return attributes;
}

function toolResultTranscript(messages: number, parts: number, partChars: number): unknown[] {
  const text = "o".repeat(partChars);
  return Array.from({ length: messages }, (_, index) => ({
    role: "toolResult",
    toolCallId: `call-${index}`,
    content: Array.from({ length: parts }, () => ({ type: "text", text })),
  }));
}

function redactionCharsFor(run: () => unknown): number {
  redaction.chars = 0;
  run();
  return redaction.chars;
}

describe("OTEL content redaction cost", () => {
  // Input messages export as two JSON attributes; each redacts at most 8x its budget of
  // clipped text plus its serialized JSON.
  const modelCallMaxWork = 2 * 9 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;
  // Every fixture string is longer than the widest redaction window, so doubling it must not
  // change how much text reaches the redactor.

  it.each([
    {
      name: "a model call's large tool outputs",
      maxWork: modelCallMaxWork,
      capture: (scale: number) => captureModelCall(toolResultTranscript(6, 1, scale * 150_000)),
    },
    {
      name: "a model call with many tool output parts",
      maxWork: modelCallMaxWork,
      capture: (scale: number) => captureModelCall(toolResultTranscript(200, 5, scale * 15_000)),
    },
    {
      name: "a log body",
      maxWork: 4 * MAX_OTEL_LOG_BODY_CHARS,
      capture: (scale: number) =>
        normalizeOtelLogString("o".repeat(scale * 150_000), MAX_OTEL_LOG_BODY_CHARS),
    },
  ])("does not grow with $name beyond its export budget", ({ maxWork, capture }) => {
    const work = redactionCharsFor(() => capture(1));

    expect(redactionCharsFor(() => capture(2))).toBe(work);
    expect(work).toBeLessThan(maxWork);
  });
});

describe("OTEL content redaction at the export cut", () => {
  const exportPaths = [
    {
      name: "a model-call message part",
      // The first JSON budget keeps 8,192 characters of a clipped string, suffix included.
      keptChars: 8192 - TRUNCATED_SUFFIX.length,
      exportText: (text: string) =>
        String(captureModelCall([{ role: "user", content: text }])["gen_ai.input.messages"]),
    },
    {
      name: "a log body",
      keptChars: MAX_OTEL_LOG_BODY_CHARS,
      exportText: (text: string) => normalizeOtelLogString(text, MAX_OTEL_LOG_BODY_CHARS),
    },
  ];

  it.each(exportPaths)("masks a token that crosses the cut in $name", (path) => {
    // The token starts 10 characters before the cut; unmasked, the export would end "glpat-A1b2".
    const text = `${"x".repeat(path.keptChars - 11)} ${SECRET_TOKEN} ${"y".repeat(400_000)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).toContain("glpat-…");
    expect(exported).not.toContain("glpat-A1b2");
  });

  it.each(exportPaths)("drops a private key cut off before its end line in $name", (path) => {
    const keyBlock = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;
    const text = `${"x".repeat(path.keptChars - 400)}\n${keyBlock}\n${"y".repeat(400_000)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).not.toContain(PRIVATE_KEY_BODY.slice(0, 32));
  });

  it("redacts line-start assignments in content that fits without truncation", () => {
    const attributes = captureModelCall([
      { role: "user", content: `notes\npassword=${SECRET_BODY}` },
    ]);

    for (const key of ["gen_ai.input.messages", "openclaw.content.input_messages"]) {
      expect(String(attributes[key])).not.toContain(SECRET_BODY);
    }
  });
});
