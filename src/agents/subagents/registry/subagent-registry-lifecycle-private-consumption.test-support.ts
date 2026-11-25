import { expect, it } from "vitest";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { resolveSubagentDeliveryStatus } from "./subagent-list.js";
import {
  readLifecycleRun,
  type CompleteLifecycleRun,
  type RunEntryOverrides,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Fork carry of upstream #191857 (c22b4779f6e): a completionTarget "parent" result consumed in
// a private parent turn settles as consumed_privately unless the host confirmed a visible final.
export function registerPrivateConsumptionCases({
  createReceiptFixture,
  completeAndJoinCleanup,
  visibleCompletion,
}: {
  createReceiptFixture: (
    delivery: SubagentAnnounceDeliveryResult,
    outcome: "delivered",
    overrides: RunEntryOverrides,
  ) => { entry: SubagentRunRecord; controller: SubagentLifecycleController };
  completeAndJoinCleanup: CompleteLifecycleRun;
  visibleCompletion: Parameters<CompleteLifecycleRun>[2];
}) {
  it.each([
    ["parent", undefined, "consumed_privately"],
    ["parent", true, "delivered"],
    [undefined, undefined, "delivered"],
  ] as const)(
    "settles completionTarget=%s visibleFinal=%s as %s",
    async (completionTarget, requesterVisibleFinalDelivered, label) => {
      const { entry, controller } = createReceiptFixture(
        { delivered: true, path: "direct", requesterVisibleFinalDelivered },
        "delivered",
        { completionTarget },
      );
      await completeAndJoinCleanup(controller, entry, visibleCompletion);
      expect(resolveSubagentDeliveryStatus(readLifecycleRun(entry))).toBe(label);
    },
  );
}
