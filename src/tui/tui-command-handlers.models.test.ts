// Covers TUI /model and /models command handlers and their catalog reads.

import { describe, expect, it, vi } from "vitest";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";

describe("tui command handlers model commands", () => {
  it("shows the resolved model reference including a nested provider prefix", async () => {
    const h = createTuiCommandHandlersHarness({
      patchSession: vi.fn().mockResolvedValue({
        entry: {},
        resolved: { modelProvider: "nvidia", model: "moonshotai/kimi-k2.5" },
      }),
    });
    await h.handleCommand("/model kimi");
    expect(h.patchSession).toHaveBeenCalledWith(expect.objectContaining({ model: "kimi" }));
    expect(h.addSystem).toHaveBeenCalledWith("model set to nvidia/moonshotai/kimi-k2.5");
  });

  it("names the selected agent for the /models catalog read on multi-agent rosters", async () => {
    // Unscoped model reads must name a single owner; multi-agent rosters throw
    // AgentSelectionRequiredError otherwise (self-poll regression).
    const listModels = vi
      .fn()
      .mockResolvedValue([
        { provider: "openrouter", id: "openrouter/auto", name: "OpenRouter Auto" },
      ]);
    const { handleCommand, openOverlay } = createTuiCommandHandlersHarness({
      listModels,
      currentAgentId: "voice",
    });

    await handleCommand("/models");

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledWith({ agentId: "voice" });
    expect(openOverlay).toHaveBeenCalled();
  });
});
