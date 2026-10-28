import { vi } from "vitest";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob } from "../../cron/types.js";

export function createMockCronService(
  workflowMocks: {
    cronAdd: CronServiceContract["add"];
    cronListPage: CronServiceContract["listPage"];
    cronRemove: CronServiceContract["remove"];
  },
  makeCronJob: (input: Partial<CronJob> & { id: string }) => CronJob,
): CronServiceContract {
  return {
<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
    readEventSources: vi.fn<CronServiceContract["readEventSources"]>(async () => []),
    runEvent: vi.fn<CronServiceContract["runEvent"]>(async () => ({ kind: "invalidated" })),
=======
>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      enabled: true,
      triggersEnabled: true,
      storePath: "/tmp/openclaw-test-cron.json",
      storage: "sqlite" as const,
      sqlitePath: "/tmp/openclaw-test-state/state/openclaw.sqlite",
      jobs: 0,
<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
=======
      reauthorizationRequired: 0,
>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
      nextWakeAtMs: null,
    })),
    list: vi.fn(async () => []),
    listPage: workflowMocks.cronListPage,
    add: workflowMocks.cronAdd,
    update: vi.fn(async (id, patch) => makeCronJob({ id, ...patch })),
    updateWithPrecondition: vi.fn(async (id, patch, precondition) => {
      const job = makeCronJob({ id });
      await precondition(job, Date.now());
      return makeCronJob({ ...job, ...patch });
    }),
    remove: workflowMocks.cronRemove,
    run: vi.fn<CronServiceContract["run"]>(async () => ({
      ok: true,
      ran: false,
      reason: "not-due",
    })),
    enqueueRun: vi.fn<CronServiceContract["enqueueRun"]>(async () => ({
      ok: true,
      ran: false,
      reason: "not-due",
    })),
    getJob: vi.fn(() => undefined),
    readJob: vi.fn(async () => undefined),
    getDefaultAgentId: vi.fn(() => undefined),
<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
    wake: vi.fn<CronServiceContract["wake"]>(async () => ({ ok: true })),
=======
    wake: vi.fn<CronServiceContract["wake"]>(() => ({ ok: true })),
>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
  };
}
