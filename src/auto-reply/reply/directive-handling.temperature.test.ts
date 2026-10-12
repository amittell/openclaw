// Tests the /temperature (alias /temp) session directive: parsing, directive-only
// detection, clearing, and handler behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { hasSessionDirectives, parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { extractTemperatureDirective } from "./directives.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";

vi.mock("../../agents/sticky-model-selection.js", () => ({
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

function baseAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

function baseConfig(): OpenClawConfig {
  return {
    agents: { defaults: {} },
    models: { providers: {} },
  };
}

function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "s1",
    updatedAt: Date.now(),
    delivery: { kind: "none" },
    ...overrides,
  };
}

function createHandleParams(
  overrides: Partial<HandleDirectiveOnlyParams>,
): HandleDirectiveOnlyParams {
  const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
  const sessionEntry = overrides.sessionEntry ?? createSessionEntry();
  return {
    cfg: baseConfig(),
    // 9.2 made agentId required on the core params; keep the builder self-sufficient.
    agentId: overrides.agentId ?? "main",
    directives: parseInlineSessionDirectives(""),
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    sessionKey,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    aliasIndex: baseAliasIndex(),
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "anthropic",
    model: "claude-opus-4-6",
    initialModelLabel: "anthropic/claude-opus-4-6",
    formatModelSwitchEvent: (label) => `Switched to ${label}`,
    ...overrides,
  };
}

function runHandleCommand(command: string, overrides: Partial<HandleDirectiveOnlyParams> = {}) {
  return handleDirectiveOnly(
    createHandleParams({ ...overrides, directives: parseInlineSessionDirectives(command) }),
  );
}

const NATIVE_TEMPERATURE = { command: { kind: "native", name: "temperature" } } as const;

function isTemperatureDirectiveOnly(directives: ReturnType<typeof parseInlineSessionDirectives>) {
  return isDirectiveOnly({
    directives,
    cleanedBody: directives.cleaned,
    ctx: buildTestCtx(),
    cfg: baseConfig(),
    isGroup: false,
  });
}

function expectNoTemperatureState(directives: ReturnType<typeof parseInlineSessionDirectives>) {
  expect(directives.hasTemperatureDirective).toBe(false);
  expect(directives.temperature).toBeUndefined();
  expect(directives.rawTemperature).toBeUndefined();
  expect(directives.clearTemperature).toBe(false);
  expect(hasSessionDirectives(directives)).toBe(false);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("extractTemperatureDirective", () => {
  it("parses a numeric temperature argument", () => {
    const res = extractTemperatureDirective("/temperature 0.7");
    expect(res.hasDirective).toBe(true);
    expect(res.temperature).toBe(0.7);
    expect(res.rawTemperature).toBe("0.7");
    expect(res.cleaned).toBe("");
  });

  it("parses the /temp alias", () => {
    const res = extractTemperatureDirective("/temp 1.5");
    expect(res.hasDirective).toBe(true);
    expect(res.temperature).toBe(1.5);
  });

  it("parses colon form", () => {
    const res = extractTemperatureDirective("/temperature:0.2 run fast");
    expect(res.hasDirective).toBe(true);
    expect(res.temperature).toBe(0.2);
    expect(res.cleaned).toBe("run fast");
  });

  it("matches with no argument", () => {
    const res = extractTemperatureDirective("/temperature");
    expect(res.hasDirective).toBe(true);
    expect(res.temperature).toBeUndefined();
    expect(res.rawTemperature).toBeUndefined();
  });

  it("does not match /temperature followed by extra letters", () => {
    const res = extractTemperatureDirective("/temperaturex");
    expect(res.hasDirective).toBe(false);
  });

  it("rejects out-of-range values", () => {
    const res = extractTemperatureDirective("/temperature 3.5");
    expect(res.hasDirective).toBe(true);
    expect(res.temperature).toBeUndefined();
    expect(res.rawTemperature).toBe("3.5");
  });

  it("treats default as a clear directive", () => {
    const parsed = parseInlineSessionDirectives("/temperature default");
    expect(parsed.hasTemperatureDirective).toBe(true);
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.rawTemperature).toBe("default");
    expect(parsed.clearTemperature).toBe(true);
  });
});

describe("handleDirectiveOnly temperature behavior", () => {
  it("sets a session temperature from /temperature", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/temperature 0.7", { sessionEntry });

    expect(result?.text).toContain("Temperature set to 0.7.");
    expect(sessionEntry.temperature).toBe(0.7);
  });

  it("accepts the /temp alias", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/temp 1.2", { sessionEntry });

    expect(result?.text).toContain("Temperature set to 1.2.");
    expect(sessionEntry.temperature).toBe(1.2);
  });

  it("reports the current temperature when no argument is given", async () => {
    const sessionEntry = createSessionEntry({ temperature: 0.9 });
    const result = await runHandleCommand("/temperature", { sessionEntry });

    expect(result?.text).toContain("Current temperature: 0.9.");
    expect(result?.text).toContain("Options: 0–2, default.");
    expect(sessionEntry.temperature).toBe(0.9);
  });

  it("reports default when no temperature is set", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/temp", { sessionEntry });

    expect(result?.text).toContain("Current temperature: default.");
    expect(sessionEntry.temperature).toBeUndefined();
  });

  it("rejects unrecognized temperature values", async () => {
    const sessionEntry = createSessionEntry();
    const result = await runHandleCommand("/temperature 9", { sessionEntry });

    expect(result?.text).toContain('Unrecognized temperature "9".');
    expect(sessionEntry.temperature).toBeUndefined();
  });

  it("clears the temperature override for default directives", async () => {
    const sessionEntry = createSessionEntry({ temperature: 1.4 });
    const result = await runHandleCommand("/temperature default", { sessionEntry });

    expect(result?.text).toContain("Temperature reset to default.");
    expect(sessionEntry.temperature).toBeUndefined();
  });
});

describe("/temperature directive-only detection", () => {
  it.each(["/temperature 0.3", "/temp 1.1", "/temperature", "/temperature default"])(
    "answers a message that is only %s without running the model",
    (body) => {
      const directives = parseInlineSessionDirectives(body);
      expect(directives.hasTemperatureDirective).toBe(true);
      expect(hasSessionDirectives(directives)).toBe(true);
      expect(isTemperatureDirectiveOnly(directives)).toBe(true);
    },
  );

  it("keeps the request after /temperature as the agent body", () => {
    const directives = parseInlineSessionDirectives("/temperature 0.3 write a haiku");
    expect(directives.temperature).toBe(0.3);
    expect(directives.cleaned).toBe("write a haiku");
    expect(isTemperatureDirectiveOnly(directives)).toBe(false);
  });
});

describe("native /temperature command parsing", () => {
  it("rejects a non-numeric native argument instead of passing it to the model", async () => {
    const directives = parseInlineSessionDirectives("/temperature warm please", NATIVE_TEMPERATURE);
    expect(directives.hasTemperatureDirective).toBe(true);
    expect(directives.rawTemperature).toBe("warm");
    expect(directives.temperature).toBeUndefined();
    expect(directives.command?.name).toBe("temperature");
    expect(isTemperatureDirectiveOnly(directives)).toBe(true);

    const sessionEntry = createSessionEntry({ temperature: 0.9 });
    const result = await handleDirectiveOnly(
      createHandleParams({
        sessionEntry,
        directives: parseInlineSessionDirectives("/temperature warm", NATIVE_TEMPERATURE),
      }),
    );
    expect(result?.text).toContain('Unrecognized temperature "warm".');
    expect(sessionEntry.temperature).toBe(0.9);
  });

  it("leaves a non-numeric text-form argument in the message as prose", () => {
    const directives = parseInlineSessionDirectives("/temperature warm please");
    expect(directives.hasTemperatureDirective).toBe(true);
    expect(directives.rawTemperature).toBeUndefined();
    expect(directives.cleaned).toBe("warm please");
    expect(directives.command).toBeUndefined();
  });

  it("applies a numeric native /temperature to the session", async () => {
    const sessionEntry = createSessionEntry();
    const result = await handleDirectiveOnly(
      createHandleParams({
        sessionEntry,
        directives: parseInlineSessionDirectives("/temperature 0.4", NATIVE_TEMPERATURE),
      }),
    );
    expect(result?.text).toContain("Temperature set to 0.4.");
    expect(sessionEntry.temperature).toBe(0.4);
  });
});

describe("cleared directives carry no /temperature state", () => {
  it("drops /temperature for a sender who cannot use text directives", () => {
    const ctx = buildTestCtx({
      CommandBody: "/temperature default",
      RawBody: "/temperature default",
    });
    expect(ctx.commandText).toBe("/temperature default");
    const result = resolveReplyDirectiveRouting({
      commandText: ctx.commandText,
      agentText: ctx.agentText,
      modelAliases: [],
      canInterpretTextDirectives: false,
      isAuthorizedSender: false,
      isGroup: false,
      wasMentioned: false,
      ctx,
      cfg: baseConfig(),
      agentId: "main",
      resetTriggered: false,
    });
    expectNoTemperatureState(result.directives);
  });

  it("returns a fresh cleared object after a temperature parse", () => {
    parseInlineSessionDirectives("/temperature 1.9");
    const first = clearInlineDirectives("a");
    (first as { temperature?: number }).temperature = 1.7;
    const second = clearInlineDirectives("b");
    expect(second.cleaned).toBe("b");
    expectNoTemperatureState(second);
  });
});
