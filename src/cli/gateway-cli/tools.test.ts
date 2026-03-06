import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";

const { defaultRuntime, runtimeLogs, runtimeErrors, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => {
    try {
      await action();
    } catch (err) {
      onError(err);
    }
  },
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({
    gateway: {
      port: 18789,
      auth: { token: "test-token-from-config" },
    },
  }),
  resolveGatewayPort: (cfg?: { gateway?: { port?: number } }) => cfg?.gateway?.port ?? 18789,
}));

const { addGatewayToolsCommands, invokeGatewayTool } = await import("./tools.js");

let fetchMock: ReturnType<typeof vi.fn>;

function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
}

beforeEach(() => {
  resetRuntimeCapture();
  vi.restoreAllMocks();
});

describe("addGatewayToolsCommands", () => {
  function buildProgram() {
    const program = new Command();
    const gateway = program.command("gateway");
    addGatewayToolsCommands(gateway);
    return program;
  }

  it("registers gateway tools invoke command", () => {
    const program = buildProgram();
    const toolsCmd = program.commands
      .find((c) => c.name() === "gateway")
      ?.commands.find((c) => c.name() === "tools");
    expect(toolsCmd).toBeDefined();
    const invokeCmd = toolsCmd?.commands.find((c) => c.name() === "invoke");
    expect(invokeCmd).toBeDefined();
  });

  it("requires --tool flag", async () => {
    const program = buildProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(["gateway", "tools", "invoke"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("invokes tool and displays result", async () => {
    installFetchMock(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              content: [{ type: "text", text: JSON.stringify({ sessions: [] }) }],
            },
          }),
          { status: 200 },
        ),
    );

    const program = buildProgram();
    await program.parseAsync(["gateway", "tools", "invoke", "--tool", "sessions_list"], {
      from: "user",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:18789/tools/invoke");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body.tool).toBe("sessions_list");
    expect(body.args).toEqual({});
    expect(body.sessionKey).toBeUndefined();
  });

  it("includes session-key in request body when provided", async () => {
    installFetchMock(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { content: [] } }), {
          status: 200,
        }),
    );

    const program = buildProgram();
    await program.parseAsync(
      ["gateway", "tools", "invoke", "--tool", "sessions_list", "--session-key", "agent:main:main"],
      { from: "user" },
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.sessionKey).toBe("agent:main:main");
  });

  it("passes parsed --args JSON in request body", async () => {
    installFetchMock(
      async () =>
        new Response(
          JSON.stringify({ ok: true, result: { content: [{ type: "text", text: '"ok"' }] } }),
          { status: 200 },
        ),
    );

    const program = buildProgram();
    await program.parseAsync(
      ["gateway", "tools", "invoke", "--tool", "memory_recall", "--args", '{"query":"tonal sync"}'],
      { from: "user" },
    );

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.tool).toBe("memory_recall");
    expect(body.args).toEqual({ query: "tonal sync" });
  });

  it("outputs raw JSON with --json flag", async () => {
    const rawResult = {
      ok: true,
      result: {
        content: [{ type: "text", text: JSON.stringify({ sessions: ["a", "b"] }) }],
      },
    };
    installFetchMock(async () => new Response(JSON.stringify(rawResult), { status: 200 }));

    const program = buildProgram();
    await program.parseAsync(["gateway", "tools", "invoke", "--tool", "sessions_list", "--json"], {
      from: "user",
    });

    expect(runtimeLogs.length).toBe(1);
    const output = JSON.parse(runtimeLogs[0]);
    expect(output.ok).toBe(true);
    expect(output.result.content).toBeDefined();
  });

  it("sends auth token from config", async () => {
    installFetchMock(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );

    const program = buildProgram();
    await program.parseAsync(["gateway", "tools", "invoke", "--tool", "test_tool"], {
      from: "user",
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer test-token-from-config");
  });

  it("prefers explicit --token over config", async () => {
    installFetchMock(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );

    const program = buildProgram();
    await program.parseAsync(
      ["gateway", "tools", "invoke", "--tool", "test_tool", "--token", "explicit-token"],
      { from: "user" },
    );

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer explicit-token");
  });

  it("exits with error on HTTP failure", async () => {
    installFetchMock(
      async () =>
        new Response(
          JSON.stringify({ ok: false, error: { message: "Tool not available: bad_tool" } }),
          { status: 404 },
        ),
    );

    const program = buildProgram();
    try {
      await program.parseAsync(["gateway", "tools", "invoke", "--tool", "bad_tool"], {
        from: "user",
      });
    } catch {
      // exit(1) throws __exit__:1 in test runtime
    }

    expect(runtimeErrors.length).toBeGreaterThan(0);
    expect(runtimeErrors[0]).toContain("Tool not available: bad_tool");
  });
});

describe("invokeGatewayTool", () => {
  it("converts ws:// URL to http://", async () => {
    installFetchMock(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );

    await invokeGatewayTool({
      tool: "test",
      url: "ws://myhost:18789",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://myhost:18789/tools/invoke");
  });

  it("converts wss:// URL to https://", async () => {
    installFetchMock(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );

    await invokeGatewayTool({
      tool: "test",
      url: "wss://secure.host:443",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://secure.host:443/tools/invoke");
  });
});
