import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type { CronJob } from "../../cron/types.js";
import type { CronCallerScope } from "./cron-caller-scope.js";

export function requiresExplicitAgentRuntimeToolsAllow(params: {
  job: Pick<CronJob, "payload" | "trigger">;
  callerScope: CronCallerScope | undefined;
}): boolean {
  return (
    params.callerScope !== undefined &&
    !params.callerScope.manageAll &&
    cronJobUsesToolRuntime(params.job) &&
    params.job.payload.toolsAllow === undefined
  );
}
