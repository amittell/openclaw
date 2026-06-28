// Model Catalog Core tests cover configured model refs behavior.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredModelRefs,
  collectConfiguredModelRefValues,
  listModelRefsFromConfigValue,
} from "./configured-model-refs.js";

describe("configured model refs", () => {
  it("lists raw refs from one model selector without normalizing them", () => {
    expect(listModelRefsFromConfigValue("  openai/gpt-5.5  ")).toEqual(["  openai/gpt-5.5  "]);
    expect(
      listModelRefsFromConfigValue({
        primary: " primary/model ",
        fallbacks: ["", "fallback/model", 42, "fallback/model"],
      }),
    ).toEqual([" primary/model ", "", "fallback/model", "fallback/model"]);
    expect(listModelRefsFromConfigValue(["openai/gpt-5.5"])).toEqual([]);
    expect(listModelRefsFromConfigValue({ primary: 42, fallbacks: "openai/gpt-5.5" })).toEqual([]);
  });

  it("collects agent, hook, message, and channel model refs with config paths", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            utilityModel: "google/gemini-3.1-flash-lite-preview",
            mediaModels: { image: "openai/gpt-image-2" },
            compaction: { memoryFlush: { model: "openai/gpt-5.5-mini" } },
          },
          entries: {
            custom: {
              model: "xai/grok-4-fast",
              utilityModel: "openai/gpt-5.5-nano",
            },
          },
        },
        hooks: {
          mappings: [{ model: "openai/gpt-5.5-nano" }],
        },
        tts: { summaryModel: "openai/gpt-5.5-mini" },
        channels: {
          modelByChannel: {
            discord: {
              guild: "anthropic/claude-opus-4-8",
            },
          },
        },
      }),
    ).toEqual([
      { path: "agents.defaults.model.primary", value: "openai/gpt-5.5" },
      { path: "agents.defaults.model.fallbacks.0", value: "anthropic/claude-sonnet-4-6" },
      {
        path: "agents.defaults.utilityModel",
        value: "google/gemini-3.1-flash-lite-preview",
      },
      { path: "agents.defaults.mediaModels.image", value: "openai/gpt-image-2" },
      { path: "agents.defaults.compaction.memoryFlush.model", value: "openai/gpt-5.5-mini" },
      { path: "agents.entries.custom.model", value: "xai/grok-4-fast" },
      { path: "agents.entries.custom.utilityModel", value: "openai/gpt-5.5-nano" },
      { path: "channels.modelByChannel.discord.guild", value: "anthropic/claude-opus-4-8" },
      { path: "hooks.mappings.0.model", value: "openai/gpt-5.5-nano" },
      { path: "tts.summaryModel", value: "openai/gpt-5.5-mini" },
    ]);
  });

  it("can exclude channel model overrides from configured refs", () => {
    expect(
      collectConfiguredModelRefValues(
        {
          agents: { defaults: { model: "openai/gpt-5.5" } },
          channels: { modelByChannel: { discord: { guild: "anthropic/claude-sonnet-4-6" } } },
        },
        { includeChannelModelOverrides: false },
      ),
    ).toEqual(["openai/gpt-5.5"]);
  });

  it("preserves legacy list indices when collecting agent model refs", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          list: [
            { id: "10", model: "openai/gpt-5.6" },
            { id: "2", utilityModel: "anthropic/claude-sonnet-4-6" },
          ],
        },
      }),
    ).toEqual([
      { path: "agents.list.0.model", value: "openai/gpt-5.6" },
      { path: "agents.list.1.utilityModel", value: "anthropic/claude-sonnet-4-6" },
    ]);
  });

  it("ignores a shadowed legacy list when keyed entries are authoritative", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          entries: { ops: { model: "openai/gpt-5.6" } },
          list: [{ id: "stale", model: "anthropic/claude-opus-4-8" }],
        },
      }),
    ).toEqual([{ path: "agents.entries.ops.model", value: "openai/gpt-5.6" }]);
  });

  it("ignores array-shaped malformed records", () => {
    expect(
      collectConfiguredModelRefs({
        agents: {
          defaults: {
            models: ["openai/gpt-5.5"],
          },
        },
      }),
    ).toEqual([]);
  });

  it("collects execution-path model defaults (chat, dispatch, subagents)", () => {
    // The split agent defaults each carry their own selector; every path must
    // be collected or a configured model silently misses catalog validation.
    const refs = collectConfiguredModelRefs({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          chat: { model: "openai/gpt-5.5-chat" },
          dispatch: { model: { primary: "openai/gpt-5.4-mini" } },
          subagents: { model: { primary: "openai/gpt-5.5-mini" } },
        },
      },
    });
    const byPath = new Map(refs.map((ref) => [ref.path, ref.value]));
    expect(byPath.get("agents.defaults.chat.model")).toBe("openai/gpt-5.5-chat");
    expect(byPath.get("agents.defaults.dispatch.model.primary")).toBe("openai/gpt-5.4-mini");
    expect(byPath.get("agents.defaults.subagents.model.primary")).toBe("openai/gpt-5.5-mini");
  });
});
