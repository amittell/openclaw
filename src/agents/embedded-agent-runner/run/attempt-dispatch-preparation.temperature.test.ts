// Coverage for the session-level /temperature dispatch plumbing.
import { describe, expect, it, vi } from "vitest";
import { resolveSessionTemperatureOverride } from "./run-attempt-dispatch.session-temperature.js";

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    readSessionEntryReadOnlyInWorker: vi.fn(),
  };
});

import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";

const mockedRead = vi.mocked(readSessionEntryReadOnlyInWorker);

describe("resolveSessionTemperatureOverride", () => {
  it("returns the session temperature when present", async () => {
    mockedRead.mockResolvedValue({ temperature: 0.7 } as never);
    await expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).resolves.toBe(0.7);
    expect(mockedRead).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    );
  });

  it("returns undefined when the session has no temperature", async () => {
    mockedRead.mockResolvedValue({ thinkingLevel: "low" } as never);
    await expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the entry is missing", async () => {
    mockedRead.mockResolvedValue(undefined);
    await expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits when there is no session key", async () => {
    mockedRead.mockReset();
    await expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: undefined }),
    ).resolves.toBeUndefined();
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("returns undefined when the store read rejects", async () => {
    mockedRead.mockRejectedValue(new Error("store unavailable"));
    await expect(
      resolveSessionTemperatureOverride({ agentId: "main", sessionKey: "agent:main:dm:1" }),
    ).resolves.toBeUndefined();
  });

  it("passes an explicit store path through", async () => {
    mockedRead.mockResolvedValue({ temperature: 1.2 } as never);
    await expect(
      resolveSessionTemperatureOverride({
        agentId: "main",
        sessionKey: "agent:main:dm:1",
        storePath: "/custom/store.json",
      }),
    ).resolves.toBe(1.2);
    expect(mockedRead).toHaveBeenCalledWith(
      expect.objectContaining({ storePath: "/custom/store.json" }),
    );
  });
});
