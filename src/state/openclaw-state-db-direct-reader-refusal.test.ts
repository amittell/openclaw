import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawStateIntegrityAdmission } from "./openclaw-state-db-async-lifecycle.js";
import {
  assertDirectReaderIntegrity,
  describeDirectReaderRefusal,
} from "./openclaw-state-db-direct-reader-refusal.js";

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => loggerMocks),
}));

const REFUSAL = "Direct shared-state reader requires current integrity admission";
const SCHEMA = "/state/openclaw.sqlite";

function integrity(params: {
  revision: bigint;
  epoch: bigint;
  proof: bigint;
}): OpenClawStateIntegrityAdmission {
  const revision = new SharedArrayBuffer(8);
  const proof = new SharedArrayBuffer(8);
  new BigInt64Array(revision)[0] = params.revision;
  new BigInt64Array(proof)[0] = params.proof;
  return {
    identity: { key: "file:test", canonicalPath: SCHEMA },
    revision,
    epoch: params.epoch,
    proof,
  };
}

beforeEach(() => {
  loggerMocks.warn.mockClear();
});

describe("describeDirectReaderRefusal", () => {
  it("admits a current revision with published proof", () => {
    expect(
      describeDirectReaderRefusal(integrity({ revision: 3n, epoch: 3n, proof: 7n }), SCHEMA),
    ).toBeUndefined();
  });

  it("admits a fresh database without integrity", () => {
    expect(describeDirectReaderRefusal(undefined, undefined)).toBeUndefined();
  });

  it("admits a current revision with unpublished proof when the schema is not existing", () => {
    expect(
      describeDirectReaderRefusal(integrity({ revision: 3n, epoch: 3n, proof: -1n }), undefined),
    ).toBeUndefined();
  });

  it("names a moved revision, with or without an existing schema", () => {
    expect(
      describeDirectReaderRefusal(integrity({ revision: 4n, epoch: 3n, proof: 7n }), SCHEMA),
    ).toEqual({ cause: "revision-moved", revision: 4n, epoch: 3n, existingSchemaPath: SCHEMA });
    expect(
      describeDirectReaderRefusal(integrity({ revision: 4n, epoch: 3n, proof: 7n }), undefined),
    ).toEqual({ cause: "revision-moved", revision: 4n, epoch: 3n, existingSchemaPath: undefined });
  });

  it("names an existing schema without integrity", () => {
    expect(describeDirectReaderRefusal(undefined, SCHEMA)).toEqual({
      cause: "no-integrity",
      existingSchemaPath: SCHEMA,
    });
  });

  it("names an existing schema whose proof was never published", () => {
    expect(
      describeDirectReaderRefusal(integrity({ revision: 3n, epoch: 3n, proof: -1n }), SCHEMA),
    ).toEqual({ cause: "proof-unpublished", existingSchemaPath: SCHEMA });
  });
});

describe("assertDirectReaderIntegrity", () => {
  it("passes silently when admitted", () => {
    expect(() =>
      assertDirectReaderIntegrity(integrity({ revision: 3n, epoch: 3n, proof: 7n }), SCHEMA),
    ).not.toThrow();
    expect(loggerMocks.warn).not.toHaveBeenCalled();
  });

  it("keeps the original refusal message and logs the condition that fired", () => {
    expect(() =>
      assertDirectReaderIntegrity(integrity({ revision: 5n, epoch: 3n, proof: 7n }), SCHEMA),
    ).toThrow(REFUSAL);
    expect(() => assertDirectReaderIntegrity(undefined, SCHEMA)).toThrow(REFUSAL);
    expect(() =>
      assertDirectReaderIntegrity(integrity({ revision: 3n, epoch: 3n, proof: -1n }), SCHEMA),
    ).toThrow(REFUSAL);
    expect(loggerMocks.warn.mock.calls.map(([message]) => message)).toEqual([
      `direct shared-state reader refused: cause=revision-moved integrity=present revision=5 epoch=3 existingSchemaPath=${SCHEMA}`,
      `direct shared-state reader refused: cause=no-integrity integrity=absent existingSchemaPath=${SCHEMA}`,
      `direct shared-state reader refused: cause=proof-unpublished integrity=present existingSchemaPath=${SCHEMA}`,
    ]);
  });
});
