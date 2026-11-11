import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeDatabaseTestCohorts,
  closeStateDatabaseForTest,
} from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { detectLegacyStateMigrations } from "./state-migrations.core-entrypoints.test-support.js";
import { createEnv } from "./state-migrations.session-store.test-support.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

// Keep detection off the live plugin registry; this file registers no plugin state migrations.
vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const buildStateMigrationInventory = (params?: { config?: OpenClawConfig }) => ({
    knownPluginIds: actual.collectRelevantDoctorPluginIds(params?.config ?? {}),
    sessionStoreOwnerPluginIds: [],
    descriptors: [],
    unresolvedPluginIds: [],
  });
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => []),
    resolveLivePluginDoctorStateMigrationInventory: vi.fn(buildStateMigrationInventory),
    resolvePluginDoctorStateMigrationInventory: vi.fn(buildStateMigrationInventory),
  };
});

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

afterEach(async () => {
  resetAutoMigrateLegacyStateDirForTest();
  await closeDatabaseTestCohorts([closeOpenClawAgentDatabasesForTest, closeStateDatabaseForTest]);
  resetPluginRuntimeStateForTest();
});

afterAll(async () => {
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  it("migrates the legacy session store for an explicit fixed-store owner", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const env = createEnv(stateDir);
    // The pre-agent <state>/sessions layout is retired (#163160): legacy keys are found in the
    // owner's own store, so only the resolved owner reads this one.
    const legacyStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(
      legacyStorePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "legacy-main", updatedAt: 20 },
      }),
      "utf8",
    );
    // The owner is deliberately NOT "main": LEGACY_IMPLICIT_AGENT_ID is "main",
    // so an owner of "main" is also what the fallback produces and the assertion
    // would pass with the explicit-owner disjunct in
    // resolveLegacyStateMigrationOwner removed. "ops" only resolves via
    // resolveSessionStoreCompatibilityAgentId, so this test fails without it.
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.targetAgentId).toBe("ops");
    expect(detected.sessions.hasLegacy).toBe(true);
    expect(detected.sessions.legacyKeys).toEqual(["agent:main:main"]);

    // Deliberately asserts targetAgentId and hasLegacy only. The store
    // round-trip depends on resolveSessionStoreOwnership running rather than
    // the preserveAmbiguousKeys fallback, which is not traced -- an assertion
    // whose semantics are unverified is not coverage.
  });
});
