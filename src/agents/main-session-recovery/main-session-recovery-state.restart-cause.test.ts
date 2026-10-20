import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

// Fork #13: the recovery cycle records whether Gateway close or boot marked it, so the
// resume notice can say "restart" only when one happened.

function cycle(overrides: Partial<MainRestartRecoveryState> = {}): MainRestartRecoveryState {
  return { cycleId: "cycle-1", revision: 1, chargedAttempts: 0, ...overrides };
}

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session-1", updatedAt: 100, status: "running", ...overrides };
}

function mark(target: SessionEntry, cause?: "gateway_restart") {
  return transitionMainSessionRecovery(target, {
    kind: "mark_interrupted",
    cycleId: "cycle-new",
    now: 200,
    ...(cause ? { cause } : {}),
  });
}

describe("main session recovery cause", () => {
  it("records the restart cause on the cycle a restart mark creates", () => {
    const fresh = entry();
    expect(mark(fresh, "gateway_restart")).toEqual({ kind: "applied" });
    expect(fresh.mainRestartRecovery).toEqual(
      cycle({ cycleId: "cycle-new", cause: "gateway_restart" }),
    );

    const unattributed = entry();
    mark(unattributed);
    expect(unattributed.mainRestartRecovery).toEqual(cycle({ cycleId: "cycle-new" }));
  });

  it("attributes an existing cycle to a later restart and bumps its revision", () => {
    const target = entry({
      abortedLastRun: true,
      mainRestartRecovery: cycle({ chargedAttempts: 1 }),
    });
    mark(target, "gateway_restart");
    expect(target.mainRestartRecovery).toEqual(
      cycle({ revision: 2, chargedAttempts: 1, cause: "gateway_restart" }),
    );
  });

  it("keeps a recorded restart when an operator recovery marks without a cause", () => {
    const target = entry({
      abortedLastRun: true,
      mainRestartRecovery: cycle({ cause: "gateway_restart" }),
    });
    mark(target);
    expect(target.mainRestartRecovery).toEqual(cycle({ cause: "gateway_restart" }));
  });

  it("still hands a foreground claim to the restart when it records the cause", () => {
    const target = entry({
      abortedLastRun: true,
      mainRestartRecovery: cycle({
        foregroundClaims: { lifecycleGeneration: "generation-1", tokens: ["foreground-1"] },
      }),
    });
    mark(target, "gateway_restart");
    expect(target.mainRestartRecovery).toEqual(cycle({ revision: 2, cause: "gateway_restart" }));
  });
});
