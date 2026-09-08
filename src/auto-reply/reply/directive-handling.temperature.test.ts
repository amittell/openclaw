// Tests the /temperature (alias /temp) session directive: parsing and handler behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handleDirectiveOnly } from "./directive-handling.impl.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { extractTemperatureDirective } from "./directives.js";

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
