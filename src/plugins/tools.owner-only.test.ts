// A plugin tool registered `ownerOnly` keeps its declaration for non-owners but never runs.
import { afterEach, expect, it, vi } from "vitest";
import { isOwnerOnlyToolStub } from "../agents/owner-only-tool-stub-marker.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { getPluginToolMeta } from "./tool-metadata.js";
import { resolvePluginTools } from "./tools.js";

afterEach(() => setCurrentPluginMetadataSnapshot(undefined));

it("gives a non-owner turn only a refusing stub of an ownerOnly tool, and an unknown sender none", async () => {
  const workspaceDir = "/tmp";
  const config = {
    plugins: { enabled: true, load: { paths: ["/tmp/plugin.js"] }, slots: { memory: "none" } },
  };
  const artifact = {
    source: "/tmp/owner-demo.js",
    rootDir: workspaceDir,
    origin: "bundled" as const,
    preferBuiltPluginArtifacts: false,
  };
  const record = createPluginRecord({
    id: "owner-demo",
    ...artifact,
    enabled: true,
    configSchema: true,
    contracts: { tools: ["owner_tool"] },
  });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: false,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
  });
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: record.id, ...artifact, enabledByDefault: true, contracts: record.contracts }],
  });
  snapshot.policyHash = resolveInstalledPluginIndexPolicyHash(config);
  snapshot.workspaceDir = workspaceDir;
  setCurrentPluginMetadataSnapshot(snapshot, { config, workspaceDir });
  const { registry, createApi } = createTestPluginRegistry(createPluginRuntime());
  registry.plugins.push(record);
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ran" }],
    details: {},
  }));
  try {
    const api = createApi(record, { config });
    runPluginRegisterSyncInRegistry(
      () =>
        api.registerTool(
          () => ({
            name: "owner_tool",
            label: "Owner tool",
            description: "owner_tool tool",
            parameters: { type: "object", properties: {} },
            execute,
          }),
          { name: "owner_tool", ownerOnly: true },
        ),
      api,
      registry,
      record.id,
    );
    expect(registry.diagnostics).toEqual([]);
    const resolve = (owner: boolean | undefined) =>
      resolvePluginTools({
        context: { config, workspaceDir, senderIsOwner: owner },
        runtimeRegistry: registry,
      });
    const [ownerTool] = resolve(true);
    const [stub] = resolve(false);
    if (!ownerTool || !stub) {
      throw new Error("expected the owner tool and its stub");
    }
    // Listing and headless surfaces pass no sender; they keep omitting the tool.
    expect(resolve(undefined)).toEqual([]);

    expect(isOwnerOnlyToolStub(ownerTool)).toBe(false);
    expect(isOwnerOnlyToolStub(stub)).toBe(true);
    const declaration = ({ name, description, parameters }: typeof stub) => ({
      name,
      description,
      parameters,
    });
    expect(declaration(stub)).toEqual(declaration(ownerTool));
    // Catalog ids and plugin tool groups classify by plugin owner, so the stub keeps it.
    expect(getPluginToolMeta(stub)?.pluginId).toBe("owner-demo");
    await expect(stub.execute("call", {})).rejects.toThrow(
      "owner_tool is not available on this turn: owner-only.",
    );
    expect(execute).not.toHaveBeenCalled();
    await ownerTool.execute("owner-call", {});
    expect(execute).toHaveBeenCalledOnce();
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
