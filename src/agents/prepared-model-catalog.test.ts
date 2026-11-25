import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  agentDir: "/tmp/prepared-model-catalog-agent",
  workspaceDir: "/tmp/prepared-model-catalog-workspace",
  config: {} as object,
  agentIds: ["main"],
  agentDirs: new Map<string, string>(),
  activateSnapshot: vi.fn(),
  acquireSnapshot: vi.fn(),
  getSnapshot: vi.fn(),
  loadSnapshot: vi.fn(),
  prepareSnapshot: vi.fn(),
  prepareScopedCatalog: vi.fn(),
  refreshStaleCatalog: vi.fn(),
  isFullCatalog: vi.fn(),
  releaseSnapshot: vi.fn(async () => {}),
  releasePublishedSnapshot: vi.fn(async () => {}),
  // When set, drive the ambient owner resolvers in agent-scope.js mock (default None preserves
  // the prior always-"main" behavior for every existing test).
  legacyCompatAgentId: undefined as string | undefined | null,
  defaultAgentResolver: undefined as (() => string) | undefined,
  // resolveInputs calls resolveAmbientOwnerAgentId, NOT resolveDefaultAgentId. Stubbing the
  // latter alone leaves the ambient lookup hard-coded, so the degrade branch is unreachable.
  ambientOwnerResolver: undefined as (() => string) | undefined,
}));
const { agentDir, workspaceDir } = mocks;

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.config,
}));

import {
  AgentSelectionRequiredError,
  AgentSelectionRequiredError as RealAgentSelectionRequiredError,
} from "./agent-scope-config.js";
// mock-isolation: Use fixed agent directories without ambient workspace discovery.
vi.mock("./agent-scope.js", () => ({
  listAgentIds: () => mocks.agentIds,
  resolveAgentDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR
      ? `${env.OPENCLAW_STATE_DIR}/${agentId}`
      : (mocks.agentDirs.get(agentId) ?? mocks.agentDir),
  resolveAgentWorkspaceDir: (_config: object, agentId: string, env?: NodeJS.ProcessEnv) =>
    env?.OPENCLAW_STATE_DIR ? `${env.OPENCLAW_STATE_DIR}/workspace-${agentId}` : mocks.workspaceDir,
  resolveAmbientOwnerAgentId: () =>
    mocks.ambientOwnerResolver ? mocks.ambientOwnerResolver() : "main",
  resolveDefaultAgentDir: () => mocks.agentDir,
  resolveDefaultAgentId: () => (mocks.defaultAgentResolver ? mocks.defaultAgentResolver() : "main"),
  tryResolveLegacyCompatibilityAgentId: () =>
    mocks.legacyCompatAgentId === null
      ? undefined
      : mocks.legacyCompatAgentId !== undefined
        ? mocks.legacyCompatAgentId
        : "main",
  AgentSelectionRequiredError: RealAgentSelectionRequiredError,
}));

// mock-isolation: Control runtime leases and publication without starting catalog owners.
vi.mock("./prepared-model-runtime.js", async () => {
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("./prepared-model-runtime.errors.js");
  const lease = async (snapshot: Promise<unknown>, release = mocks.releaseSnapshot) => ({
    snapshot: await snapshot,
    run: <T>(run: () => T): T => run(),
    [Symbol.asyncDispose]: release,
  });
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    acquireAgentRunPreparedModelRuntime: (input: Record<string, unknown>) =>
      lease(mocks.acquireSnapshot(input)),
    activateStandalonePreparedModelRuntime: mocks.activateSnapshot,
    acquireReadOnlyPreparedModelRuntime: (input: Record<string, unknown>) =>
      lease(mocks.loadSnapshot({ ...input, readOnly: true })),
    getPreparedModelRuntimeSnapshot: mocks.getSnapshot,
    preparedModelRuntimeConfigsMatch: (left: object, right: object) =>
      JSON.stringify(left) === JSON.stringify(right),
    prepareModelRuntimeSnapshot: mocks.prepareSnapshot,
    acquirePreparedModelRuntimeSnapshot: (...args: unknown[]) =>
      lease(mocks.prepareSnapshot(...args), mocks.releasePublishedSnapshot),
    refreshPreparedModelRuntimeCatalog: mocks.refreshStaleCatalog,
  };
});

// mock-isolation: Control full-catalog classification independently of runtime discovery.
vi.mock("./prepared-model-runtime.full-catalog.js", () => ({
  isPreparedModelCatalogFull: mocks.isFullCatalog,
}));

// mock-isolation: Supply scoped catalog results without provider discovery.
vi.mock("./prepared-model-runtime.scoped-catalog.js", () => ({
  prepareScopedReadOnlyModelCatalog: mocks.prepareScopedCatalog,
}));

import { loadCommandArgMenuModelCatalog } from "../auto-reply/command-arg-menu-catalog.js";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot as getPublishedOwner,
  getPreparedModelCatalogSnapshot as getCatalog,
  loadPreparedModelCatalogOwnerSnapshot as loadOwner,
  loadPreparedModelCatalogSnapshot as loadCatalog,
  loadResolvedPublishedModelCatalogOwner as resolvePublishedOwner,
  loadPublishedPreparedModelCatalog as loadPublishedCatalog,
  loadPublishedPreparedModelCatalogOwnerSnapshot as loadPublishedOwner,
  withPreparedModelCatalogOwner as withOwner,
} from "./prepared-model-catalog.js";
import {
  getPreparedModelRuntimeAuthStore,
  setPreparedModelFullCatalogAuth,
  bindPreparedModelRuntimeAuth,
} from "./prepared-model-runtime-auth.js";
import { PreparedModelRuntimeOwnerNotPublishedError } from "./prepared-model-runtime.js";

function catalog(id: string, name: string, provider = "test") {
  return { entries: [{ provider, id, name }], routeVariants: [] };
}

const fullSnapshot = {
  config: mocks.config,
  catalogOwner: { agentId: "main", workspaceDir },
  authModes: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot: { index: { plugins: [] }, plugins: [] },
  modelCatalog: catalog("full", "Full"),
};
const readOnlySnapshot = {
  config: mocks.config,
  modelCatalog: catalog("read-only", "Read only"),
};

function unpublished() {
  mocks.prepareSnapshot.mockRejectedValue(new PreparedModelRuntimeOwnerNotPublishedError());
}

function bindFullCatalog(modelCatalog: ReturnType<typeof catalog>) {
  setPreparedModelFullCatalogAuth(modelCatalog, {
    authStore: fullSnapshot.authStore,
    authModes: fullSnapshot.authModes,
    providerAuthLabels: new Map(),
  });
}

describe("prepared model catalog access", () => {
  beforeEach(() => {
    mocks.agentIds = ["main"];
    mocks.agentDirs.clear();
    for (const mock of Object.values(mocks)) {
      if (vi.isMockFunction(mock)) {
        mock.mockReset();
      }
    }
    mocks.legacyCompatAgentId = undefined;
    mocks.defaultAgentResolver = undefined;
    mocks.ambientOwnerResolver = undefined;
  });

  // Projection rejection/release is covered with real SQLite by the resources sibling.
  it("retains the published owner until its refresh rejects", async () => {
    const release = mocks.releasePublishedSnapshot;
    const entered = createDeferred();
    const resume = createDeferred();
    const failure = new Error("catalog operation failed");
    mocks.prepareSnapshot.mockResolvedValue({ ...fullSnapshot, loadFullModelCatalog: vi.fn() });
    mocks.refreshStaleCatalog.mockImplementation(async () => {
      expect(release).not.toHaveBeenCalled();
      entered.resolve();
      await resume.promise;
      expect(release).not.toHaveBeenCalled();
      throw failure;
    });
    const project = vi.fn();
    const result = withOwner({ refreshFullCatalog: true }, project);
    const outcome = expect(result).rejects.toBe(failure);
    await entered.promise;
    expect(release).not.toHaveBeenCalled();
    resume.resolve();
    await outcome;
    expect(release).toHaveBeenCalledOnce();
    expect(project).not.toHaveBeenCalled();
  });

  it("resolves the sole ambient owner for an unscoped catalog read on a single-agent host", () => {
    // Explicit per-agent reads keep the intentional AgentSelectionRequiredError contract: an
    // unscoped ambient read on a single-agent host still resolves that one owner instead of
    // degrading to a no-owner shape.
    mocks.agentIds = ["main"];
    mocks.getSnapshot.mockReturnValue(fullSnapshot);
    const resolved = getCatalog({});
    expect(resolved).toBe(fullSnapshot.modelCatalog);
    expect(mocks.getSnapshot).toHaveBeenCalledOnce();
    const lifecycleInput = mocks.getSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(lifecycleInput).toHaveProperty("agentId", "main");
  });

  it("degrades an unscoped multi-agent catalog read to a no-owner shape instead of throwing", () => {
    // Self-poll regression: an explicit multi-agent roster with no default owner made the
    // unscoped ambient read throw AgentSelectionRequiredError out of resolveInputs (the
    // tryResolveLegacyCompatibilityAgentId ?? resolveDefaultAgentId lookup). The producer now
    // degrades that ambient case to a no-owner shape (agentId omitted) and resolves one catalog
    // owner instead of failing the read. Driven through the real catch branch by overriding the
    // ambient resolvers to their multi-agent no-default behavior.
    mocks.agentIds = ["main", "voice", "ratbot"];
    mocks.legacyCompatAgentId = null; // force the legacy resolver to return undefined (no owner)
    const noDefaultOwner = () => {
      throw new AgentSelectionRequiredError(["main", "voice", "ratbot"], {
        surface: "this Gateway request",
        hint: "Set agentId to one of the configured agents.",
      });
    };
    mocks.defaultAgentResolver = noDefaultOwner;
    // resolveInputs reaches the ambient lookup through resolveAmbientOwnerAgentId; overriding
    // only resolveDefaultAgentId left it returning "main" and the degrade branch never ran.
    mocks.ambientOwnerResolver = noDefaultOwner;
    // The single unscoped read must NOT propagate AgentSelectionRequiredError (the self-poll
    // regression). It degrades to a no-owner shape: the ambient owner lookup resolves no agentId,
    // so the lifecycle input omits agentId and the owner-snapshot read returns undefined rather
    // than throwing (callers already handle the no-owner shape).
    const read: () => unknown = () => getCatalog({});
    expect(read).not.toThrow(AgentSelectionRequiredError);
    // The no-owner read resolves (returns undefined, not a thrown error).
    const result = read();
    expect(result).toBeUndefined();
    // resolveInputs degraded to a no-owner shape: agentId omitted from the lifecycle input.
    expect(mocks.getSnapshot).toHaveBeenCalled();
    const lifecycleInput = mocks.getSnapshot.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(lifecycleInput).not.toHaveProperty("agentId");
  });

  it("keeps the per-agent-owner path failing closed on an ambiguous directory", async () => {
    // The per-agent-owner resolution (prepared-model-catalog-owner.ts) must still fail closed:
    // a shared directory with multiple configured agents names no single owner and rejects.
    mocks.agentIds = ["main", "worker"];
    mocks.agentDirs.set("main", "/tmp/shared-agent-dir");
    mocks.agentDirs.set("worker", "/tmp/shared-agent-dir");
    const committedSnapshot = {
      ...fullSnapshot,
      agentDir: "/tmp/shared-agent-dir",
      config: { agents: { list: [{ id: "main", default: true }, { id: "worker" }] } },
      // fullSnapshot carries catalogOwner for "main". Spreading it leaves the guard at
      // prepared-model-catalog-owner.ts:46 unreachable, since that only fires on an absent
      // owner. A shared directory names no single owner, which is what this asserts.
      catalogOwner: undefined,
    };
    mocks.prepareSnapshot.mockResolvedValue(committedSnapshot);

    await expect(resolvePublishedOwner({ agentId: "worker", readOnly: true })).rejects.toThrow(
      "did not identify one configured agent",
    );
  });

  it("uses the requested environment for directory selection and workspace activation", async () => {
    mocks.agentIds = ["main", "worker"];
    const env = { OPENCLAW_STATE_DIR: "/tmp/selected-catalog-state" };
    unpublished();
    mocks.loadSnapshot.mockResolvedValue(readOnlySnapshot);

    await expect(
      loadCatalog({
        agentDir: "/tmp/selected-catalog-state/worker",
        readOnly: true,
        env,
      }),
    ).resolves.toEqual(readOnlySnapshot.modelCatalog);
    expect(mocks.loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        workspaceDir: "/tmp/selected-catalog-state/workspace-worker",
        env,
      }),
    );
  });

  it("returns the published owner without config matching or catalog materialization", () => {
    const committedSnapshot = {
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/committed" } } },
      loadFullModelCatalog: vi.fn(),
    };
    mocks.getSnapshot.mockReturnValue(committedSnapshot);

    expect(
      getPublishedOwner({
        config: { agents: { defaults: { model: "openai/requested" } } },
        allowGatewaySubagentBinding: true,
      }),
    ).toBe(committedSnapshot);
    expect(committedSnapshot.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(mocks.prepareSnapshot).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses published full inventory or builds a scoped catalog (full=%s)",
    async (full) => {
      const scopedCatalog = catalog("claude", "Claude", "anthropic");
      mocks.prepareSnapshot.mockResolvedValue(full ? fullSnapshot : readOnlySnapshot);
      mocks.isFullCatalog.mockReturnValue(full);
      if (!full) {
        mocks.prepareScopedCatalog.mockResolvedValue(scopedCatalog);
      }
      await expect(
        loadCatalog({
          readOnly: true,
          providerDiscoveryProviderIds: ["anthropic"],
        }),
      ).resolves.toBe(full ? fullSnapshot.modelCatalog : scopedCatalog);
      if (!full) {
        expect(mocks.prepareScopedCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true, workspaceDir }),
          ["anthropic"],
          "static",
        );
      }
    },
  );

  it("keeps read-only facts, cached full reads, and forced refreshes distinct", async () => {
    const configuredCatalog = catalog("configured", "Configured");
    const discoveredCatalog = catalog("discovered", "Discovered");
    const { authStore, ...snapshotFacts } = fullSnapshot;
    bindFullCatalog(discoveredCatalog);
    const loadFullModelCatalog = vi.fn(async () => discoveredCatalog);
    const snapshot = {
      ...snapshotFacts,
      modelCatalog: configuredCatalog,
      loadFullModelCatalog,
    };
    bindPreparedModelRuntimeAuth(snapshot, { store: authStore });
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    await expect(loadCatalog({ readOnly: true })).resolves.toBe(configuredCatalog);
    expect(loadFullModelCatalog).not.toHaveBeenCalled();

    const materialized = await loadOwner({ readOnly: false });
    expect(materialized.modelCatalog).toBe(discoveredCatalog);
    expect(materialized).not.toHaveProperty("authStore");
    expect(getPreparedModelRuntimeAuthStore(materialized)).toBe(authStore);
    expect(loadFullModelCatalog).toHaveBeenCalledExactlyOnceWith({ refresh: false });

    await loadOwner({ readOnly: false, refreshFullCatalog: true });
    expect(loadFullModelCatalog).toHaveBeenLastCalledWith({ refresh: true });

    mocks.getSnapshot.mockReturnValue(snapshot);
    expect(getCatalog({ readOnly: true })).toBe(configuredCatalog);
    expect(getCatalog()).toBe(configuredCatalog);
  });

  it("resolves a complete published owner for runtime consumers", async () => {
    mocks.prepareSnapshot.mockResolvedValue({
      ...fullSnapshot,
      agentDir,
      config: { agents: { entries: { main: {} } } },
    });

    await expect(resolvePublishedOwner({ agentId: "MAIN", readOnly: true })).resolves.toMatchObject(
      { agentId: "main", agentDir, workspaceDir, authModes: {}, authStore: fullSnapshot.authStore },
    );
  });

  it("keeps a shared-directory published replacement owner ambiguous", async () => {
    mocks.agentIds = ["main", "worker"];
    mocks.agentDirs.set("main", "/tmp/shared-agent-dir");
    mocks.agentDirs.set("worker", "/tmp/shared-agent-dir");
    mocks.prepareSnapshot.mockResolvedValue({
      ...fullSnapshot,
      agentDir: "/tmp/shared-agent-dir",
      catalogOwner: undefined,
      config: { agents: { entries: { main: {}, worker: {} } } },
    });

    await expect(
      loadPublishedOwner({ agentId: "worker", readOnly: true }),
    ).resolves.not.toHaveProperty("agentId");
    await expect(resolvePublishedOwner({ agentId: "worker", readOnly: true })).rejects.toThrow(
      "did not identify one configured agent",
    );
  });

  it("defaults exact and published data reads to completed facts without acquisition", async () => {
    const completedCatalog = catalog("completed", "Completed");
    const snapshot = {
      ...fullSnapshot,
      readFullModelCatalog: vi.fn(() => completedCatalog),
      loadFullModelCatalog: vi.fn().mockRejectedValue(new Error("unrequested discovery")),
    };
    bindFullCatalog(completedCatalog);
    mocks.getSnapshot.mockReturnValue(snapshot);
    mocks.prepareSnapshot.mockResolvedValue(snapshot);

    await expect(loadCatalog()).resolves.toBe(completedCatalog);
    await expect(loadPublishedCatalog()).resolves.toBe(completedCatalog.entries);
    expect(snapshot.loadFullModelCatalog).not.toHaveBeenCalled();
    expect(mocks.refreshStaleCatalog).not.toHaveBeenCalled();
  });

  it.each(["prepareSnapshot", "activateSnapshot", "acquireSnapshot"] as const)(
    "rejects a catalog owner built from another config by %s",
    async (source) => {
      if (source !== "prepareSnapshot") {
        unpublished();
      }
      mocks[source].mockResolvedValue({
        ...fullSnapshot,
        config: { agents: { defaults: { model: "openai/old" } } },
      });
      const project = vi.fn();
      if (source === "prepareSnapshot") {
        await expect(withOwner({}, project)).rejects.toBeInstanceOf(
          PreparedModelCatalogConfigReplacedError,
        );
        expect(project).not.toHaveBeenCalled();
        expect(mocks.releasePublishedSnapshot).toHaveBeenCalledOnce();
        expect(mocks.activateSnapshot).not.toHaveBeenCalled();
      } else {
        await expect(loadCatalog({ readOnly: false })).rejects.toThrow("requested config");
        if (source === "acquireSnapshot") {
          expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it("serves native command menus from the published owner after a config republish", async () => {
    const published = {
      ...fullSnapshot,
      config: { agents: { defaults: { model: "openai/published" } } },
    };
    mocks.getSnapshot.mockReturnValue(published);
    mocks.prepareSnapshot.mockResolvedValue(published);
    const cfg = { agents: { defaults: { model: "openai/current" } } };

    // Exact readers still refuse a generation built from another config.
    await expect(
      loadCatalog({ config: cfg, agentId: "main", readOnly: true }),
    ).rejects.toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
    await expect(loadCommandArgMenuModelCatalog({ cfg, agentId: "main" })).resolves.toEqual(
      published.modelCatalog.entries,
    );
    expect(mocks.prepareSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "main", agentDir, config: cfg }),
      { readPublished: true },
    );
    expect(mocks.activateSnapshot).not.toHaveBeenCalled();
  });

  it("leases a full generation for a gateway preflight in a dynamic workspace", async () => {
    unpublished();
    mocks.activateSnapshot.mockResolvedValue(undefined);
    mocks.acquireSnapshot.mockResolvedValue(fullSnapshot);

    await expect(
      loadCatalog({ workspaceDir: "/tmp/spawned-workspace", readOnly: false }),
    ).resolves.toBe(fullSnapshot.modelCatalog);

    expect(mocks.acquireSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/spawned-workspace" }),
    );
    expect(mocks.releaseSnapshot).toHaveBeenCalledOnce();
  });
});
