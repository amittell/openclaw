/**
 * Installs one channel plugin, completed from the shared channel test base, as the active
 * plugin registry for outbound delivery tests.
 *
 * Split out of ./deliver.test.ts to keep that file within the max-lines budget.
 */
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

export function setTestPlugin(
  plugin: Pick<ChannelPlugin, "id"> & Partial<ChannelPlugin>,
  pluginId = plugin.id,
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId,
        source: "test",
        plugin: { ...createChannelTestPluginBase({ id: plugin.id }), ...plugin },
      },
    ]),
  );
}
