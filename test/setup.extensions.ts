// Extension test setup installs extension-specific mocks and cleanup.
import { afterAll, beforeEach, vi } from "vitest";
import { resetMessageToolSendSuppressionForTest } from "../src/agents/tools/message-tool-execution.send-suppression.js";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup({ loadProfileEnv: false });

beforeEach(() => {
  vi.useRealTimers();
  // FORK ADDITION (upstream carries this file unmodified; keep the diff to these
  // two lines so a future carry can re-apply it mechanically).
  //
  // The fork's duplicate-send guard keeps process-global state keyed by runId
  // (src/agents/tools/message-tool-execution.send-suppression.ts). That key is
  // deliberately per-RUN and not per-tool-instance, because the message tool is
  // rebuilt for every attempt (run/attempt-tool-prepare.ts) and a re-narration
  // spanning two attempts of one run is exactly the pathology the guard exists
  // to catch. Scoping the map to the instance would silently break that.
  //
  // The consequence is that a suite reusing one runId across logically distinct
  // cases carries sends from one into the next and suppresses them - which is
  // what upstream's dynamic-tool-build.test.ts does (runId "run-1" for every
  // it.each case, identical text), so its later cases never reach the TTS path
  // and synthesize is called 0 times where 1 is expected. Clearing the trackers
  // between tests fixes it without touching the guard or any upstream assertion.
  resetMessageToolSendSuppressionForTest();
});

afterAll(async () => {
  const { drainAgentDatabaseResources } = await vi.importActual<
    typeof import("../src/state/openclaw-agent-db-resources.js")
  >("../src/state/openclaw-agent-db-resources.js");
  // File-owned homes must survive until retained Worker leases have been released.
  await drainAgentDatabaseResources({}, async () => {
    testEnv.cleanup();
  });
});
