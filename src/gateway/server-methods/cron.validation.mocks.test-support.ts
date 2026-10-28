import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronRunRecord } from "../../cron/store/run-history.types.js";
import type { CronCreatorSessionLookup } from "./cron-creator-session.test-support.js";

// Module mocks shared by the cron method validation suites; import this file first so
// the mocks register before the cron handlers load.
const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
const loadGatewaySessionEntry = vi.hoisted(() =>
  vi.fn((sessionKey: string): CronCreatorSessionLookup => ({
    canonicalKey: sessionKey,
    entry: undefined,
  })),
);
const cronRunRecordsOverride = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<typeof import("../../cron/store/read-only.js").readCronRunRecords>
    ) => Promise<CronRunRecord[]> | undefined
  >(),
);
const resolveCronDeliveryPreview = vi.hoisted(() =>
  vi.fn(async () => ({ label: "not requested", detail: "not requested" })),
);
const resolveCronDeliveryPreviews = vi.hoisted(() =>
  vi.fn(async ({ jobs }: { jobs: Array<{ id: string }> }) =>
    Object.fromEntries(
      jobs.map((job) => [job.id, { label: "not requested", detail: "not requested" }]),
    ),
  ),
);

vi.mock("../../cron/store/read-only.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store/read-only.js")>(
    "../../cron/store/read-only.js",
  );
  return {
    ...actual,
    readCronRunRecords: (...args: Parameters<typeof actual.readCronRunRecords>) =>
      cronRunRecordsOverride(...args) ?? actual.readCronRunRecords(...args),
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig,
  };
});

// mock-isolation: Validation fixtures supply session rows; real session stores stay unread.
vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadGatewaySessionEntry,
  loadGatewaySessionEntryReadOnly: loadGatewaySessionEntry,
}));

// mock-isolation: Validation fixtures do not read live session delivery metadata.
vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryFailurePreview: async () => undefined,
  resolveCronDeliveryPreview,
  resolveCronDeliveryPreviews,
}));

export {
  cronRunRecordsOverride,
  getRuntimeConfig,
  loadGatewaySessionEntry,
  resolveCronDeliveryPreview,
  resolveCronDeliveryPreviews,
};

export function resetCronValidationMocks(): void {
  getRuntimeConfig.mockReset().mockReturnValue({} as OpenClawConfig);
  cronRunRecordsOverride.mockReset();
  resolveCronDeliveryPreview
    .mockReset()
    .mockResolvedValue({ label: "not requested", detail: "not requested" });
  resolveCronDeliveryPreviews
    .mockReset()
    .mockImplementation(async ({ jobs }: { jobs: Array<{ id: string }> }) =>
      Object.fromEntries(
        jobs.map((job) => [job.id, { label: "not requested", detail: "not requested" }]),
      ),
    );
  loadGatewaySessionEntry
    .mockReset()
    .mockImplementation((sessionKey: string) => ({ canonicalKey: sessionKey, entry: undefined }));
}
