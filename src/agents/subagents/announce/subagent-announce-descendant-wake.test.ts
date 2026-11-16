import { describe, expect, it, vi } from "vitest";

const terminateAcceptedCollectorRun = vi.hoisted(() => vi.fn());
const dispatchGatewayMethodInProcess = vi.hoisted(() => vi.fn(async () => ({ runId: "wake-run" })));

// mock-isolation: Prove the wake path never aborts the collector run through real Gateway cleanup.
vi.mock("../spawn/subagent-spawn-cleanup.js", () => ({
  terminateAcceptedCollectorRun,
}));

// mock-isolation: Script the child session entry and retry wrapper without reading the session store.
vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: () => ({
    sessionId: "child-session-id",
    lifecycleRevision: "child-lifecycle",
  }),
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
}));

// 11.5 imports the in-process dispatcher from the runtime barrel instead of taking it in `deps`.
vi.mock("./subagent-announce.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagent-announce.runtime.js")>()),
  dispatchGatewayMethodInProcess,
  getRuntimeConfig: () => ({}),
}));

import { runDescendantWake } from "./subagent-announce-descendant-wake.js";

describe("runDescendantWake", () => {
  it("propagates the owning gateway resolver through dispatch and successor replacement", async () => {
    const resolveGatewayContext = () => ({ owner: "gateway-a" }) as never;
    const replaceSubagentRunAfterSteer = vi.fn(async () => true);

    await expect(
      runDescendantWake({
        runId: "parent-run",
        childSessionKey: "agent:main:subagent:parent",
        taskLabel: "parent task",
        findings: "child findings",
        announceId: "announce-parent",
        prepareCurrent: async () => true,
        isChildSessionEffectsAllowed: () => true,
        replaceSubagentRunAfterSteer,
        resolveGatewayContext,
      }),
    ).resolves.toBe(true);

    expect(dispatchGatewayMethodInProcess).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({ resolveGatewayContext }),
    );
    expect(replaceSubagentRunAfterSteer).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayContextResolver: resolveGatewayContext }),
    );
    expect(terminateAcceptedCollectorRun).not.toHaveBeenCalled();
  });
});
