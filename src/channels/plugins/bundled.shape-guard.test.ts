import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.resetModules();
});

describe("bundled channel entry shape guards", () => {
  it("treats missing bundled discovery results as empty", async () => {
    vi.resetModules();
    vi.doMock("../../plugins/discovery.js", () => ({
      discoverOpenClawPlugins: () => ({
        candidates: [],
        diagnostics: [],
      }),
    }));
    vi.doMock("../../plugins/manifest-registry.js", () => ({
      loadPluginManifestRegistry: () => ({
        plugins: [],
        diagnostics: [],
      }),
    }));

    const bundled = await import("./bundled.js");

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });
});

describe("OPENCLAW_SKIP_CHANNEL_PLUGINS bypass", () => {
  it("returns empty arrays when OPENCLAW_SKIP_CHANNEL_PLUGINS=1", async () => {
    const original = process.env.OPENCLAW_SKIP_CHANNEL_PLUGINS;
    process.env.OPENCLAW_SKIP_CHANNEL_PLUGINS = "1";
    try {
      // Mock discovery so the test does not depend on real plugin layout.
      vi.doMock("../../plugins/discovery.js", () => ({
        discoverOpenClawPlugins: () => ({
          candidates: [],
          diagnostics: [],
        }),
      }));
      vi.doMock("../../plugins/manifest-registry.js", () => ({
        loadPluginManifestRegistry: () => ({
          plugins: [],
          diagnostics: [],
        }),
      }));
      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=skip-channel-plugins",
      );
      expect(bundled.listBundledChannelPlugins()).toEqual([]);
      expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_SKIP_CHANNEL_PLUGINS;
      } else {
        process.env.OPENCLAW_SKIP_CHANNEL_PLUGINS = original;
      }
    }
  });
});
