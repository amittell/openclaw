// Sessions abort command tests: the no-active-run outcome must stay visible and
// non-failing, and a version-skewed payload must not read as a successful stop.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsAbortCommand } from "./sessions-abort.js";

const callGatewayCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: callGatewayCli }));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

function joinedArgs(mock: { mock: { calls: unknown[][] } }): string {
  return mock.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sessionsAbortCommand", () => {
  it.each([
    ["agent", { key: "agent:main:main", agent: "" }, "--agent must not be blank"],
    ["run id", { key: "agent:main:main", runId: "  " }, "--run-id must not be blank"],
  ])("rejects a blank %s before calling the Gateway", async (_label, opts, message) => {
    const runtime = createRuntime();

    await expect(sessionsAbortCommand(opts, runtime)).rejects.toThrow(message);

    expect(callGatewayCli).not.toHaveBeenCalled();
  });

  it("names the aborted run and does not exit on success", async () => {
    callGatewayCli.mockResolvedValue({ ok: true, abortedRunId: "run-123", status: "aborted" });
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(joinedArgs(runtime.log)).toContain("run-123");
  });

  // The operator asked for the session to stop and it is already stopped. That
  // is the request satisfied, so it must not exit non-zero - but it must still
  // say so, because whoever ran this believed the session was busy.
  it("reports no-active-run visibly and still exits zero", async () => {
    callGatewayCli.mockResolvedValue({ ok: true, abortedRunId: null, status: "no-active-run" });
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    const logged = joinedArgs(runtime.log);
    expect(logged).toContain("No active run");
    // Never dead-end the caller: the line has to say what to try next.
    expect(logged).toContain("openclaw sessions list");
  });

  it("treats a payload without ok:true as a failure rather than a silent no-op", async () => {
    callGatewayCli.mockResolvedValue({ status: "aborted" });
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("exits non-zero when the Gateway call throws", async () => {
    callGatewayCli.mockRejectedValue(new Error("connection refused"));
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(joinedArgs(runtime.error)).toContain("connection refused");
  });

  it("forwards run id, agent and clearQueued, and omits what was not asked for", async () => {
    callGatewayCli.mockResolvedValue({ ok: true, abortedRunId: "run-9", status: "aborted" });
    const runtime = createRuntime();

    await sessionsAbortCommand(
      { key: "agent:work:main", runId: "run-9", agent: "work", clearQueued: true },
      runtime,
    );

    expect(callGatewayCli.mock.calls[0]?.[0]).toBe("sessions.abort");
    expect(callGatewayCli.mock.calls[0]?.[2]).toEqual({
      key: "agent:work:main",
      runId: "run-9",
      agentId: "work",
      clearQueued: true,
    });
  });

  it("sends only the key when no options are supplied", async () => {
    callGatewayCli.mockResolvedValue({ ok: true, abortedRunId: null, status: "no-active-run" });
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main" }, runtime);

    expect(callGatewayCli.mock.calls[0]?.[2]).toEqual({ key: "agent:main:main" });
  });

  it("emits the raw result in json mode without a prose line", async () => {
    const payload = { ok: true, abortedRunId: "run-5", status: "aborted" as const };
    callGatewayCli.mockResolvedValue(payload);
    const runtime = createRuntime();

    await sessionsAbortCommand({ key: "agent:main:main", json: true }, runtime);

    // writeRuntimeJson passes an indent alongside the value, so assert the
    // payload argument rather than the whole call.
    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual(payload);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
