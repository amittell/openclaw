import "./cron.validation.mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CronJob } from "../../cron/types.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { cronHandlers } from "./cron.js";
import {
  createCronCallerClient as callerClient,
  createCronJob,
  createCronTestContext,
  createCronTestInvoker,
  setCronValidationTestRegistry,
} from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";
const { getRuntimeConfig, resetCronValidationMocks } =
  await import("./cron.validation.mocks.test-support.js");

function createCronContext(currentJobs?: CronJob | CronJob[]) {
  return createCronTestContext(currentJobs, getRuntimeConfig);
}

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

async function invokeCronRemove(
  params: Record<string, unknown>,
  options?: { removeResult?: { ok: boolean; removed: boolean }; client?: GatewayClient },
) {
  const context = createCronContext();
  if (options?.removeResult) {
    context.cron.remove.mockResolvedValueOnce(options.removeResult);
  }
  return await invokeCron("cron.remove", params, { context, client: options?.client });
}

describe("cron method validation", () => {
  beforeEach(() => {
    resetCronValidationMocks();
    setCronValidationTestRegistry();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("returns no-op success when cron.remove target id is missing", async () => {
    const { respond } = await invokeCronRemove(
      { id: "missing-id" },
      { removeResult: { ok: true, removed: false } },
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { removed: false, reason: "already-gone" },
      undefined,
    );
  });

  it("returns no-op success when cron.remove remove() reports a concurrent delete", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));
    context.cron.remove.mockResolvedValueOnce({ ok: true, removed: false });

    const { respond } = await invokeCron(
      "cron.remove",
      { id: "cron-1" },
      { context, client: callerClient("ops") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      { removed: false, reason: "already-gone" },
      undefined,
    );
  });

  it("answers caller-scoped cron.remove of a missing id exactly like a foreign job", async () => {
    const foreign = await invokeCron(
      "cron.remove",
      { id: "cron-1" },
      {
        context: createCronContext(createCronJob({ id: "cron-1", agentId: "worker" })),
        client: callerClient("ops"),
      },
    );
    const missing = await invokeCron(
      "cron.remove",
      { id: "cron-1" },
      { context: createCronContext(), client: callerClient("ops") },
    );

    expect(missing.context.cron.remove).not.toHaveBeenCalled();
    expect(missing.respond.mock.calls).toEqual(foreign.respond.mock.calls);
  });
});
