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

  it.each([false, true])(
    "names the refusing stubs for the per-turn prompt with codeMode=%s",
    async (codeModeOverride) => {
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
      // With Code Mode the stubs sit behind the catalog, not in the visible tool list.
      expect(promptInput.tools.map((entry) => entry.name).includes("gateway")).toBe(
        !codeModeOverride,
      );
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
