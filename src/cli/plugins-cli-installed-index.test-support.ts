// Installed plugin index mock state behind the plugin CLI helper's module mocks.
// The helper keeps the vi.mock registrations; this module owns the records
// ("installed" index view and the persisted rows), the revision fence, and the
// mocks that read or write them.
import type { Mock } from "vitest";
import { vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

type AsyncUnknownMock = Mock<(...args: unknown[]) => Promise<unknown>>;
type ReadPersistedInstalledPluginIndexFn =
  (typeof import("../plugins/installed-plugin-index-store.js"))["readPersistedInstalledPluginIndex"];
type RestorePersistedInstalledPluginIndexIfCurrentFn =
  (typeof import("../plugins/installed-plugin-index-store-write.js"))["restorePersistedInstalledPluginIndexIfCurrent"];
type WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn =
  (typeof import("../plugins/installed-plugin-index-records.js"))["writePersistedInstalledPluginIndexInstallRecordsWithLease"];
type ReadPersistedInstalledPluginIndexInstallRecordsFn =
  (typeof import("../plugins/installed-plugin-index-records.js"))["readPersistedInstalledPluginIndexInstallRecords"];
type PluginInstallRecordMap = Record<string, PluginInstallRecord>;

let mockInstalledPluginIndexInstallRecords: PluginInstallRecordMap = {};
let mockPersistedPluginInstallRecords: PluginInstallRecordMap = {};
let mockInstalledPluginIndexRevision = 0;

function clonePluginInstallRecords(records: PluginInstallRecordMap): PluginInstallRecordMap {
  // Tests mutate records freely; clone to keep helper state from leaking across assertions.
  return structuredClone(records);
}

export function createTestInstalledPluginIndex(params: {
  policyHash: string;
  installRecords: PluginInstallRecordMap;
  plugins?: InstalledPluginIndex["plugins"];
}): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: params.policyHash,
    generatedAtMs: 0,
    refreshReason: "source-changed",
    installRecords: clonePluginInstallRecords(params.installRecords),
    plugins: params.plugins ?? [],
    diagnostics: [],
  };
}

/** Returns a clone of the installed index records the mocked readers serve. */
export function cloneMockInstalledPluginIndexInstallRecords(): PluginInstallRecordMap {
  return clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords);
}

export const loadInstalledPluginIndexInstallRecords: AsyncUnknownMock = vi.fn(async () =>
  clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
);
export const readPersistedInstalledPluginIndexInstallRecords: Mock<ReadPersistedInstalledPluginIndexInstallRecordsFn> =
  vi.fn<ReadPersistedInstalledPluginIndexInstallRecordsFn>(() =>
    clonePluginInstallRecords(mockPersistedPluginInstallRecords),
  );
export const readPersistedInstalledPluginIndexMock: Mock<ReadPersistedInstalledPluginIndexFn> =
  vi.fn<ReadPersistedInstalledPluginIndexFn>(async () => null);
const writeMockInstalledIndexWithLease: WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn =
  async (records) => {
    const previous = await readPersistedInstalledPluginIndexMock();
    const row = (index: InstalledPluginIndex, revision: number) => ({
      state_key: "plugins.installedIndex",
      value_json: JSON.stringify({ index, revision }),
      updated_at_ms: revision,
    });
    const before = previous ? row(previous, mockInstalledPluginIndexRevision) : null;
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
    mockPersistedPluginInstallRecords = clonePluginInstallRecords(records);
    mockInstalledPluginIndexRevision += 1;
    return {
      previous,
      revision: mockInstalledPluginIndexRevision,
      mutation: {
        databasePath: resolveOpenClawStateSqlitePath(),
        before,
        after: row(
          createTestInstalledPluginIndex({ policyHash: "test-policy", installRecords: records }),
          mockInstalledPluginIndexRevision,
        ),
      },
    };
  };
export const writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock: Mock<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn> =
  vi.fn<WritePersistedInstalledPluginIndexInstallRecordsWithLeaseFn>(
    writeMockInstalledIndexWithLease,
  );
export const restorePersistedInstalledPluginIndexIfCurrentMock: Mock<RestorePersistedInstalledPluginIndexIfCurrentFn> =
  vi.fn<RestorePersistedInstalledPluginIndexIfCurrentFn>(async (index, expectedRevision) => {
    if (mockInstalledPluginIndexRevision !== expectedRevision) {
      return false;
    }
    mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
      (index?.installRecords ?? {}) as PluginInstallRecordMap,
    );
    mockPersistedPluginInstallRecords = clonePluginInstallRecords(
      (index?.installRecords ?? {}) as PluginInstallRecordMap,
    );
    mockInstalledPluginIndexRevision += 1;
    return true;
  });

export function setInstalledPluginIndexInstallRecords(records: PluginInstallRecordMap): void {
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
  mockPersistedPluginInstallRecords = clonePluginInstallRecords(records);
}

export function setRecoveredPluginInstallRecords(records: PluginInstallRecordMap): void {
  mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(records);
  mockPersistedPluginInstallRecords = {};
}

/** Clears the records and revision and resets every installed index mock. */
export function resetInstalledPluginIndexMocks(): void {
  mockInstalledPluginIndexInstallRecords = {};
  mockPersistedPluginInstallRecords = {};
  mockInstalledPluginIndexRevision = 0;
  loadInstalledPluginIndexInstallRecords.mockReset();
  readPersistedInstalledPluginIndexInstallRecords.mockReset();
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockReset();
  readPersistedInstalledPluginIndexMock.mockReset();
  restorePersistedInstalledPluginIndexIfCurrentMock.mockReset();
}

/** Restores the default record-backed implementations after a reset. */
export function restoreInstalledPluginIndexMockImplementations(): void {
  loadInstalledPluginIndexInstallRecords.mockImplementation(async () =>
    clonePluginInstallRecords(mockInstalledPluginIndexInstallRecords),
  );
  readPersistedInstalledPluginIndexInstallRecords.mockImplementation(() =>
    clonePluginInstallRecords(mockPersistedPluginInstallRecords),
  );
  readPersistedInstalledPluginIndexMock.mockResolvedValue(null);
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mockImplementation(
    writeMockInstalledIndexWithLease,
  );
  restorePersistedInstalledPluginIndexIfCurrentMock.mockImplementation(
    async (index, expectedRevision) => {
      if (mockInstalledPluginIndexRevision !== expectedRevision) {
        return false;
      }
      mockInstalledPluginIndexInstallRecords = clonePluginInstallRecords(
        (index?.installRecords ?? {}) as PluginInstallRecordMap,
      );
      mockPersistedPluginInstallRecords = clonePluginInstallRecords(
        (index?.installRecords ?? {}) as PluginInstallRecordMap,
      );
      mockInstalledPluginIndexRevision += 1;
      return true;
    },
  );
}
