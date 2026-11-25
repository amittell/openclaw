/**
 * Final join of the registered sidecar stop owners at gateway close: seal every owner, wait for
 * all of them to settle, then rethrow the first failure.
 * Split out of ./server-lifecycle.ts to keep that module within the max-lines budget.
 */
import type { GatewaySidecarStopOwner } from "./server-sidecar-owners.js";

export async function sealAndJoinSidecarStopOwners(
  owners: readonly Pick<GatewaySidecarStopOwner, "sealAndJoin">[],
): Promise<void> {
  const results = await Promise.allSettled(owners.map((owner) => owner.sealAndJoin()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    throw failure.reason;
  }
}
