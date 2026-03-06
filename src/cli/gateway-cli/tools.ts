import type { Command } from "commander";
import { loadConfig, resolveGatewayPort } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";

export type GatewayToolsInvokeOpts = {
  tool?: string;
  args?: string;
  sessionKey?: string;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  json?: boolean;
};

function resolveGatewayHttpUrl(opts: GatewayToolsInvokeOpts): string {
  if (opts.url) {
    // If user provides a WS URL, convert to HTTP.
    const url = opts.url.trim();
    if (url.startsWith("ws://")) {
      return url.replace(/^ws:\/\//, "http://");
    }
    if (url.startsWith("wss://")) {
      return url.replace(/^wss:\/\//, "https://");
    }
    // Already HTTP(S) or some other scheme — use as-is.
    return url;
  }
  const cfg = loadConfig();
  const port = resolveGatewayPort(cfg);
  return `http://127.0.0.1:${port}`;
}

function resolveAuthToken(opts: GatewayToolsInvokeOpts): string | undefined {
  const token = opts.token?.trim() || opts.password?.trim();
  if (token) {
    return token;
  }
  const cfg = loadConfig();
  const cfgToken =
    cfg.gateway?.auth?.token ??
    cfg.gateway?.auth?.password ??
    (cfg.gateway as Record<string, unknown> | undefined)?.token;
  return typeof cfgToken === "string" && cfgToken.trim() ? cfgToken.trim() : undefined;
}

function parseToolResult(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }
  const obj = body as Record<string, unknown>;
  if (!obj.ok || !obj.result) {
    return body;
  }
  const result = obj.result as Record<string, unknown>;
  // Unwrap MCP-style content array.
  if (Array.isArray(result.content)) {
    const parts = result.content as Array<{ type?: string; text?: string }>;
    if (parts.length === 1 && parts[0]?.type === "text" && typeof parts[0].text === "string") {
      try {
        return JSON.parse(parts[0].text);
      } catch {
        return parts[0].text;
      }
    }
    // Multiple parts — return them directly.
    return parts.map((p) => {
      if (p.type === "text" && typeof p.text === "string") {
        try {
          return JSON.parse(p.text);
        } catch {
          return p.text;
        }
      }
      return p;
    });
  }
  return result;
}

export async function invokeGatewayTool(opts: GatewayToolsInvokeOpts): Promise<unknown> {
  const baseUrl = resolveGatewayHttpUrl(opts);
  const url = `${baseUrl.replace(/\/+$/, "")}/tools/invoke`;
  const token = resolveAuthToken(opts);
  const timeoutMs = Number(opts.timeout ?? 30_000);

  const toolArgs = opts.args ? JSON.parse(opts.args) : {};
  const requestBody: Record<string, unknown> = {
    tool: opts.tool,
    args: toolArgs,
  };
  if (opts.sessionKey) {
    requestBody.sessionKey = opts.sessionKey;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const body = await res.json();

    if (!res.ok) {
      const errMsg = body?.error?.message ?? body?.error ?? `HTTP ${res.status} ${res.statusText}`;
      throw new Error(String(errMsg));
    }

    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function addGatewayToolsCommands(gateway: Command): void {
  const tools = gateway.command("tools").description("Gateway tool operations");

  tools
    .command("invoke")
    .description("Invoke a gateway tool via HTTP API")
    .requiredOption("--tool <name>", "Tool name to invoke")
    .option("--args <json>", "Tool arguments as JSON object", "{}")
    .option("--session-key <key>", "Caller session key for visibility scoping")
    .option("--url <url>", "Gateway URL (defaults to http://127.0.0.1:{port} from config)")
    .option("--token <token>", "Gateway auth token")
    .option("--password <password>", "Gateway password")
    .option("--timeout <ms>", "Timeout in ms", "30000")
    .option("--json", "Output raw JSON", false)
    .action(async (actionOpts, command) => {
      const parentToken = inheritOptionFromParent<string>(command, "token");
      const parentPassword = inheritOptionFromParent<string>(command, "password");
      const opts: GatewayToolsInvokeOpts = {
        ...actionOpts,
        token: actionOpts.token ?? parentToken,
        password: actionOpts.password ?? parentPassword,
      };

      await runCommandWithRuntime(
        defaultRuntime,
        async () => {
          const rawResult = await invokeGatewayTool(opts);

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(rawResult, null, 2));
            return;
          }

          const parsed = parseToolResult(rawResult);
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Tool")}: ${colorize(rich, theme.muted, String(opts.tool))}`,
          );
          defaultRuntime.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
        },
        (err) => {
          defaultRuntime.error(`tools invoke: ${String(err)}`);
          defaultRuntime.exit(1);
        },
      );
    });
}
