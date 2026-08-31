// Coverage for the session-level /temperature dispatch plumbing.
import { describe, expect, it, vi } from "vitest";
import { resolveSessionTemperatureOverride } from "./attempt-dispatch-preparation.js";

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    loadSessionEntryReadOnly: vi.fn(),
    resolveSessionTranscriptRuntimeTarget: vi.fn(),
  };
});

vi.mock("../../../config/sessions.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveSessionStorePathCore: vi.fn(() => "/tmp/temperature-test-store.json"),
  };
});

import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";

const mockedLoad = vi.mocked(loadSessionEntryReadOnly);

describe("resolveSessionTemperatureOverride", () => {
  it("returns the session temperature when present", () => {
    mockedLoad.mockReturnValue({ temperature: 0.7 } as never);
    expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).toBe(0.7);
    expect(mockedLoad).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    );
  });

  it("returns undefined when the session has no temperature", () => {
    mockedLoad.mockReturnValue({ thinkingLevel: "low" } as never);
    expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).toBeUndefined();
  });

  it("returns undefined when the entry is missing", () => {
    mockedLoad.mockReturnValue(undefined);
    expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).toBeUndefined();
  });

  it("short-circuits when there is no session key", () => {
    mockedLoad.mockReset();
    expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: undefined }),
    ).toBeUndefined();
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("returns undefined when the store read throws", () => {
    mockedLoad.mockImplementation(() => {
      throw new Error("store unavailable");
    });
    expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).toBeUndefined();
  });

  it("uses an explicit store path when provided", () => {
    mockedLoad.mockReturnValue({ temperature: 1.2 } as never);
    expect(
      resolveSessionTemperatureOverride({
        agentId: "main",
        sessionKey: "agent:main:dm:1",
        storePath: "/custom/store.json",
      }),
    ).toBe(1.2);
    expect(mockedLoad).toHaveBeenCalledWith(
      expect.objectContaining({ storePath: "/custom/store.json" }),
    );
  });
});
