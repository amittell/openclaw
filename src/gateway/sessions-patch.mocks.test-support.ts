import { vi } from "vitest";

// Module mocks shared by the sessions.patch suites; import this file first so the mocks
// register before the patch applier loads.
const acpSessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionMetaForEntry: vi.fn(),
}));
const providerThinkingMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile:
    vi.fn<typeof import("../plugins/provider-thinking.js").resolveEffectiveThinkingProfile>(),
}));

vi.mock("../acp/runtime/session-meta-readonly.js", () => ({
  readAcpSessionMetaForEntry: acpSessionMetaMocks.readAcpSessionMetaForEntry,
}));

// This suite owns patch projection; provider policy artifacts have dedicated contract coverage.
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerThinkingMocks.resolveProviderThinkingProfile,
}));

export { acpSessionMetaMocks, providerThinkingMocks };

export function resetSessionsPatchProviderThinking(): void {
  providerThinkingMocks.resolveProviderThinkingProfile.mockReset();
  providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(
    ({ provider, context }) => {
      if (provider !== "openai") {
        return undefined;
      }
      if (context.modelId === "gpt-5.5") {
        return {
          levels: (["off", "minimal", "low", "medium", "high", "xhigh"] as const).map((id) => ({
            id,
          })),
        };
      }
      if (context.modelId === "gpt-5.6-luna") {
        const levels =
          context.agentRuntime === "openclaw"
            ? (["off", "minimal", "low", "medium", "high", "max", "ultra"] as const)
            : (["off", "minimal", "low", "medium", "high", "max"] as const);
        return { levels: levels.map((id) => ({ id })) };
      }
      return undefined;
    },
  );
}
