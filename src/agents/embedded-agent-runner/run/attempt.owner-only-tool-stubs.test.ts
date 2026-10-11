// The embedded attempt names owner-only stubs in the per-turn prompt context, even when
// Code Mode or Tool Search moves them behind the catalog.
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOwnerOnlyToolStub } from "../../owner-only-tool-stubs.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];

function tool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({ action: Type.String() }),
    execute: async () => ({ content: [], details: undefined }),
  };
}

describe("embedded attempt owner-only stubs", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  // Since #164296 (v2026.10.1) the shared tool surface adds the Tool Search controls
  // itself, so Tool Search (on by default) catalogs these tools unless disabled.
  it.each([
    { codeModeOverride: false, disableToolSearch: true as const, visible: true },
    { codeModeOverride: false, disableToolSearch: undefined, visible: false },
    { codeModeOverride: true, disableToolSearch: undefined, visible: false },
  ])(
    "names the refusing stubs for the per-turn prompt with codeMode=$codeModeOverride, disableToolSearch=$disableToolSearch",
    async ({ codeModeOverride, disableToolSearch, visible }) => {
      resetEmbeddedAttemptHarness();
      const hoisted = getHoisted();
      hoisted.createOpenClawCodingToolsMock.mockReturnValue([
        tool("message"),
        createOwnerOnlyToolStub(tool("gateway")),
        createOwnerOnlyToolStub(tool("nodes")),
      ]);

      const result = await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:owner-only-stubs",
        tempPaths,
        attemptOverrides: {
          codeModeOverride,
          disableToolSearch,
          disableTools: false,
          senderIsOwner: false,
          trigger: "user",
          transcriptPrompt: "hello",
          sessionPersistence: "detached",
        },
      });

      expect(result.terminal.kind).toBe("ok");
      const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
        extraSystemPrompt?: string;
        tools: Array<{ name: string }>;
      };
      // With Code Mode or Tool Search the stubs sit behind the catalog, not in the visible list.
      expect(promptInput.tools.map((entry) => entry.name).includes("gateway")).toBe(visible);
      expect(promptInput.extraSystemPrompt).toContain(
        "Owner-only tools unavailable on this turn; calls to them are refused: `gateway`, `nodes`.",
      );
    },
  );

  it("lets a client tool replace a stub of the same name, as when owner-only tools were absent", async () => {
    resetEmbeddedAttemptHarness();
    const hoisted = getHoisted();
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([
      tool("message"),
      createOwnerOnlyToolStub(tool("gateway")),
      createOwnerOnlyToolStub(tool("nodes")),
    ]);

    const result = await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:owner-only-client-tool",
      tempPaths,
      attemptOverrides: {
        clientTools: [
          {
            type: "function",
            function: {
              name: "gateway",
              description: "client gateway",
              parameters: { type: "object" },
            },
          },
        ],
        // With Tool Search on, this case re-renders the system prompt, and the re-render
        // cannot update this harness's undefined system prompt report.
        disableToolSearch: true,
        disableTools: false,
        senderIsOwner: false,
        trigger: "user",
        transcriptPrompt: "hello",
        sessionPersistence: "detached",
      },
    });

    expect(result.terminal.kind).toBe("ok");
    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      extraSystemPrompt?: string;
    };
    expect(promptInput.extraSystemPrompt).toContain(
      "Owner-only tools unavailable on this turn; calls to them are refused: `nodes`.",
    );
  });
});
