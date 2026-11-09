// Fork: restart-orphaned restart-recovery delivery claims (split out of
// restart-recovery-claim.test.ts, which sits at the 1000-line test cap).
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { ReplyRunAlreadyActiveError } from "./reply-run-registry.contracts.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ClaimControllerParams = Parameters<typeof createReplyRestartRecoveryClaimController>[0];

// The same real-admission controller fixture restart-recovery-claim.test.ts builds.
function createController(
  params: Pick<
    ClaimControllerParams,
    "getEntry" | "getSessionId" | "setEntry" | "sessionKey" | "storePath"
  > &
    Partial<ClaimControllerParams>,
) {
  if (!params.sessionKey || !params.storePath) {
    throw new Error("Recovery fixture requires a stored session");
  }
  const actor = createReplyRecoveryActorFixture({
    agentId: params.agentId ?? "main",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    getSessionId: params.getSessionId,
  });
  return createReplyRestartRecoveryClaimController({
    agentId: "main",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    isRestartAbort: () => false,
    resolveDeliveryContext: () => undefined,
    ...params,
    acquireSessionActor: () => actor.acquireSessionActor(),
  });
}

describe("createReplyRestartRecoveryClaimController restart-orphaned claims", () => {
  beforeEach(() => setRuntimeConfigSnapshot({}));
  afterEach(() => clearRuntimeConfigSnapshot());

  // Fork: a delivery claim is live only while the generation that minted it runs. A
  // row a Gateway restart left without an outcome (and unmarked) keeps the dead
  // process's claim; it must not fail every later message closed. The live case is
  // the control proving the generation check still blocks a competing message.
  it.each([
    { name: "retires a restart-orphaned claim", live: false },
    { name: "still rejects a claim minted by the running generation", live: true },
  ] as const)("$name on a row with no recorded outcome", async ({ live }) => {
    const storePath = path.join(tempDirs.make("openclaw-reply-admission-orphan-"), "sessions.json");
    const scope = { storePath, sessionKey: "agent:main:telegram:group:chat" };
    const sessionId = "channel-session-id";
    const sourceTurnId = "telegram-update-new";
    const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
    let entry: InternalSessionEntry = {
      sessionId,
      updatedAt: 10,
      abortedLastRun: false,
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryRunId: "claimed-run",
      ...(live
        ? { restartRecoveryDeliveryLifecycleGeneration: getAgentEventLifecycleGeneration() }
        : {}),
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
    };
    await replaceSessionEntry(scope, entry);
    const recorder = createUserTurnTranscriptRecorder({
      message: { role: "user", content: "continue", idempotencyKey: sourceTurnId, timestamp: 1 },
      target: { agentId: "main", sessionEntry: entry, sessionId, ...scope },
      updateMode: "none",
    });
    const controller = createController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      resolveDeliveryContext: () => deliveryContext,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId,
      ...scope,
    });

    if (live) {
      const outcome = await controller.admitUserTurn(recorder).catch((error: unknown) => error);
      // beta.4 refuses the competing message one step earlier, at the live run's reply
      // admission; 10.8 refused it at the claim. Either way the claim row is left as it was.
      expect(
        isRestartRecoveryClaimChangedError(outcome) ||
          outcome instanceof ReplyRunAlreadyActiveError,
      ).toBe(true);
      expect(loadSessionEntry(scope)).toMatchObject({
        restartRecoveryDeliveryRunId: "claimed-run",
        restartRecoveryDeliverySourceRunId: "telegram-update-old",
      });
    } else {
      await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
      const persisted = loadSessionEntry(scope);
      expect(persisted?.restartRecoveryDeliveryRunId).not.toBe("claimed-run");
      expect(persisted).toMatchObject({
        restartRecoveryDeliveryLifecycleGeneration: getAgentEventLifecycleGeneration(),
        restartRecoveryDeliverySourceRunId: sourceTurnId,
      });
    }
  });
});
