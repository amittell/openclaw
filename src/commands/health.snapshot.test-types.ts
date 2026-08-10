import type { ChannelPlugin } from "../channels/plugins/types.public.js";

export type HealthTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
>;

export type TelegramHealthAccount = {
  accountId: string;
  token: string;
  configured: boolean;
  config: {
    proxy?: string;
    network?: Record<string, unknown>;
    apiRoot?: string;
  };
};

export type DiscordHealthAccount = {
  accountId: string;
  token: string;
  tokenSource: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  enabled: boolean;
  configured: boolean;
};

export type IMessageHealthAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};
