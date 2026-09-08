import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  TaskSummarySchema,
  TasksMaintenanceParamsSchema,
  TasksMaintenanceResultSchema,
} from "./tasks.js";

describe("TaskSummarySchema", () => {
  it("accepts bounded live subagent progress and keeps diff stats closed", () => {
    const summary = {
      id: "task-1",
      status: "running",
      lastActivity: "Updating the gateway task ledger",
      diffStat: { files: 3, added: 12, removed: 4 },
    };

    expect(Value.Check(TaskSummarySchema, summary)).toBe(true);
    expect(Value.Check(TaskSummarySchema, { ...summary, lastActivity: "x".repeat(201) })).toBe(
      false,
    );
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, removed: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(TaskSummarySchema, {
        ...summary,
        diffStat: { ...summary.diffStat, unchanged: 8 },
      }),
    ).toBe(false);
  });
});

describe("TasksMaintenance schemas", () => {
  it("accepts only an empty request without caller-controlled authority", () => {
    expect(Value.Check(TasksMaintenanceParamsSchema, {})).toBe(true);
    for (const key of ["runtimeAuthoritative", "cfg", "agentId", "now", "force", "path"]) {
      expect(Value.Check(TasksMaintenanceParamsSchema, { [key]: true })).toBe(false);
    }
  });
  it("keeps all four counters required, closed and nonnegative integers", () => {
    const result = { reconciled: 1, recovered: 0, cleanupStamped: 2, pruned: 3 };
    expect(Value.Check(TasksMaintenanceResultSchema, result)).toBe(true);
    expect(Value.Check(TasksMaintenanceResultSchema, { ...result, tasks: [] })).toBe(false);
    for (const key of Object.keys(result)) {
      for (const invalid of [-1, 0.5, "1", undefined]) {
        expect(Value.Check(TasksMaintenanceResultSchema, { ...result, [key]: invalid })).toBe(
          false,
        );
      }
    }
  });
});
