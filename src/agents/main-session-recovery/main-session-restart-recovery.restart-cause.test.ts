import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import {
  createSessionEntry,
  expectRecord,
  mockCallArg,
} from "../subagent-test-fixtures.test-helpers.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

// Fork #13: a same-process abort can reach restart recovery too. Only a cycle that Gateway
// close or boot marked may tell the model, or the user, that the Gateway restarted.

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let dispatchSettlement = createDeferred();
const sendRecoveryNotice = vi.fn<
  Parameters<typeof createRecoveryRuntimeFixture>[0]["sendRecoveryNotice"]
>(async () => ({ suppressed: false }));
const gatewayRuntime = createRecoveryRuntimeFixture({
  callGateway,
  getDispatchSettlement: () => dispatchSettlement.promise,
  sendRecoveryNotice,
});

describe("restart recovery wording", () => {
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callGateway).mockReset().mockResolvedValue({ runId: "run-resumed" });
    dispatchSettlement = createDeferred();
    resetAgentEventsForTest();
    resetGatewayWorkAdmission();
    stateDir = tempDirs.make("openclaw-recovery-cause-");
  });

  afterEach(async () => {
    dispatchSettlement.resolve();
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir });
  });

  async function interruptedSession(
    mainRestartRecovery?: InternalSessionEntry["mainRestartRecovery"],
  ) {
    const sessionKey = "agent:main:telegram:group:-100123:topic:99";
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey, storePath },
      createSessionEntry({
        sessionId: "main-session",
        permissionMode: "guarded",
        updatedAt: Date.now() - 10_000,
        status: "interrupted",
        abortedLastRun: true,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123",
          accountId: "work",
          threadId: 99,
        },
        ...(mainRestartRecovery ? { mainRestartRecovery } : {}),
      }),
    );
    for (const message of [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]) {
      await appendTranscriptMessage(
        { sessionId: "main-session", sessionKey, storePath },
        { message, cwd: sessionsDir },
      );
    }
  }

  it.each([
    {
      label: "a cycle Gateway close recorded",
      cycle: { cycleId: "marked-cycle", revision: 1, chargedAttempts: 0, cause: "gateway_restart" },
      restarted: true,
    },
    {
      label: "a cycle with no restart on record",
      cycle: { cycleId: "unattributed-cycle", revision: 1, chargedAttempts: 0 },
      restarted: false,
    },
    { label: "a same-process abort with no cycle", cycle: undefined, restarted: false },
  ] as const)("claims a restart only for $label", async ({ cycle, restarted }) => {
    await interruptedSession(cycle ? { ...cycle } : undefined);

    await expect(recoverRestartAbortedMainSessions({ stateDir, gatewayRuntime })).resolves.toEqual({
      started: 1,
      settled: 0,
      failed: 0,
      skipped: 0,
    });

    const message = String(expectRecord(mockCallArg(callGateway).params, "gateway params").message);
    expect(message).toContain("Your previous turn was interrupted");
    expect(message.includes("interrupted by a gateway restart")).toBe(restarted);
    expect(message.includes("The interruption did not cancel the user's task")).toBe(!restarted);
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
    const notice = sendRecoveryNotice.mock.calls[0]?.[0].text ?? "";
    expect(notice).toContain("I'm continuing your interrupted request now");
    expect(notice.includes("the gateway has just restarted")).toBe(restarted);
  });
});
