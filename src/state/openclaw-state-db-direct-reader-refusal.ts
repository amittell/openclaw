import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";

const log = createSubsystemLogger("state/direct-reader");

export type DirectReaderRefusal =
  | {
      cause: "revision-moved";
      revision: bigint;
      epoch: bigint;
      existingSchemaPath: string | undefined;
    }
  | { cause: "no-integrity"; existingSchemaPath: string }
  | { cause: "proof-unpublished"; existingSchemaPath: string };

/**
 * Fork diagnostic (alexm/openclaw#1): names which integrity-admission condition refuses a direct
 * shared-state reader. Same refusal set as the original inline check: a moved revision, or an
 * existing schema without a published proof.
 */
export function describeDirectReaderRefusal(
  integrity: OpenClawStateIntegrityAdmission | undefined,
  existingSchemaPath: string | undefined,
): DirectReaderRefusal | undefined {
  if (integrity) {
    const revision = Atomics.load(new BigInt64Array(integrity.revision), 0);
    if (revision !== integrity.epoch) {
      return { cause: "revision-moved", revision, epoch: integrity.epoch, existingSchemaPath };
    }
  }
  if (existingSchemaPath === undefined) {
    return undefined;
  }
  if (!integrity) {
    return { cause: "no-integrity", existingSchemaPath };
  }
  if (Atomics.load(new BigInt64Array(integrity.proof), 0) === -1n) {
    return { cause: "proof-unpublished", existingSchemaPath };
  }
  return undefined;
}

function formatRefusal(refusal: DirectReaderRefusal): string {
  const integrity = refusal.cause === "no-integrity" ? "absent" : "present";
  const versions =
    refusal.cause === "revision-moved"
      ? ` revision=${refusal.revision} epoch=${refusal.epoch}`
      : "";
  return `direct shared-state reader refused: cause=${refusal.cause} integrity=${integrity}${versions} existingSchemaPath=${refusal.existingSchemaPath ?? "none"}`;
}

/** Refuses exactly as before, and logs which condition fired; the error message is unchanged. */
export function assertDirectReaderIntegrity(
  integrity: OpenClawStateIntegrityAdmission | undefined,
  existingSchemaPath: string | undefined,
): void {
  const refusal = describeDirectReaderRefusal(integrity, existingSchemaPath);
  if (refusal) {
    log.warn(formatRefusal(refusal));
    throw new Error("Direct shared-state reader requires current integrity admission");
  }
}
