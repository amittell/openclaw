import "./sessions-patch.mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  MAIN_SESSION_KEY,
  runPatch,
  expectPatchOk,
  expectPatchError,
} from "./sessions-patch.test-support.js";
const { acpSessionMetaMocks, resetSessionsPatchProviderThinking } =
  await import("./sessions-patch.mocks.test-support.js");

describe("gateway sessions patch", () => {
  beforeEach(() => {
    resetSessionsPatchProviderThinking();
  });

  afterEach(() => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReset();
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
  });

  test("persists a session temperature override", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, temperature: 0.7 },
      }),
    );
    expect(entry.temperature).toBe(0.7);
  });

  test("clears temperature when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { temperature: 1.4 } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, temperature: null },
      }),
    );
    expect(entry.temperature).toBeUndefined();
  });

  test("rejects out-of-range temperature values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, temperature: 3.5 },
    });
    expectPatchError(result, "invalid temperature");
  });
});
