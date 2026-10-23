// Shares the minimal channel-plugin fixture used by the message tool suites.
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type {
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";

type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;
type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];
type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

export function createChannelPlugin(params: {
  id: string;
  aliases?: string[];
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messageActionTargetAliases?: NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"];
  config?: Partial<ChannelPlugin["config"]>;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
}): ChannelPlugin {
  return {
    id: params.id as ChannelPlugin["id"],
    meta: {
      id: params.id as ChannelPlugin["id"],
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: "Test channel",
      aliases: params.aliases,
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      ...params.config,
    },
    ...(params.message ? { message: params.message } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
    ...(params.outbound ? { outbound: params.outbound } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
      messageActionTargetAliases: params.messageActionTargetAliases,
    },
  };
}
