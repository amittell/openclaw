// Gateway supervised lock tests cover single-runner locking for supervised gateway starts.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { TailscaleRouteOwnershipConflictError } from "../../infra/tailscale-route-ownership-error.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "../../state/openclaw-agent-db-migration-required.js";
import { testing } from "./run.test-support.js";

const loadGatewayTlsRuntimeMock = vi.hoisted(() =>
  vi.fn(async () => ({ enabled: false, required: true })),
);

vi.mock("../../infra/tls/gateway.js", () => ({
  loadGatewayTlsRuntime: loadGatewayTlsRuntimeMock,
}));

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("supervised gateway lock recovery", () => {
  it("uses exit 78 for an ambiguous persistent Tailscale route", () => {
    expect(
      testing.resolveGatewayStartupFailureExitCode(new TailscaleRouteOwnershipConflictError()),
    ).toBe(78);
  });

  it("uses exit 78 for offline agent database migration requirements", () => {
    expect(
      testing.resolveGatewayStartupFailureExitCode(
        new OpenClawAgentDatabaseMediaMigrationRequiredError("/tmp/openclaw-agent.sqlite", 14),
      ),
    ).toBe(78);
  });

  it("does not retry gateway lock errors outside a supervisor", async () => {
    const err = new GatewayLockError("gateway already running");
    const startLoop = vi.fn(async () => {
      throw err;
    });

    await expect(
      testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: null,
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
      }),
    ).rejects.toBe(err);

    expect(startLoop).toHaveBeenCalledTimes(1);
  });

  it("leaves a healthy launchd-supervised gateway in control", async () => {
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("gateway already running");
    });
    const probeStartup = vi.fn(async () => true);
    const log = createLogger();

    await testing.runGatewayLoopWithSupervisedLockRecovery({
      startLoop,
      supervisor: "launchd",
      port: 18789,
      healthHost: "0.0.0.0",
      log,
      probeStartup,
    });

    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeStartup).toHaveBeenCalledWith({ host: "0.0.0.0", port: 18789 });
    expect(log.info).toHaveBeenCalledWith(
      "gateway already running under launchd; existing gateway is healthy, leaving it in control",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses exit 78 semantics for healthy systemd-supervised lock conflicts", async () => {
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("another gateway instance is already listening");
    });
    const probeStartup = vi.fn(async () => true);

    let failure: unknown;
    try {
      await testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeStartup,
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      message: expect.stringContaining(
        "exiting with code 78 to prevent a systemd Restart=always loop",
      ),
    });
    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeStartup).toHaveBeenCalledWith({ host: "127.0.0.1", port: 18789 });
    expect(testing.resolveGatewayLockErrorExitCode(failure)).toBe(78);
  });

  it("preserves an agent-embedded owner error under a supervisor", async () => {
    const err = new GatewayLockError(
      "another embedded OpenClaw state writer is active (pid 123); lock timeout after 5000ms",
    );
    const startLoop = vi.fn(async () => {
      throw err;
    });
    const probeStartup = vi.fn(async () => true);

    await expect(
      testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeStartup,
      }),
    ).rejects.toBe(err);

    expect(startLoop).toHaveBeenCalledTimes(1);
    expect(probeStartup).not.toHaveBeenCalled();
  });

  it("bounds supervised retries when the existing gateway stays unhealthy", async () => {
    let now = 0;
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError("gateway already running");
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    let failure: unknown;
    try {
      await testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeStartup: vi.fn(async () => false),
        now: () => now,
        sleep,
        retryMs: 5,
        timeoutMs: 12,
      });
    } catch (err) {
      failure = err;
    }

    expect(failure).toMatchObject({
      message:
        "gateway already running under systemd; existing gateway did not become healthy after 12ms",
    });
    expect(testing.resolveGatewayLockErrorExitCode(failure)).toBe(1);
    expect(startLoop).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 5);
    expect(sleep).toHaveBeenNthCalledWith(3, 2);
  });

  it("retries while the startup probe sees a draining predecessor", async () => {
    const startLoop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new GatewayLockError("gateway already running"))
      .mockResolvedValueOnce();
    const probeStartup = vi.fn(async () => false);
    const sleep = vi.fn(async () => {});

    await testing.runGatewayLoopWithSupervisedLockRecovery({
      startLoop,
      supervisor: "launchd",
      port: 18789,
      healthHost: "127.0.0.1",
      log: createLogger(),
      probeStartup,
      sleep,
      retryMs: 5,
      timeoutMs: 12,
    });

    expect(startLoop).toHaveBeenCalledTimes(2);
    expect(probeStartup).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(5);
  });

  it("bounds supervised retries for EADDRINUSE lock errors", async () => {
    let now = 0;
    const startLoop = vi.fn(async () => {
      throw new GatewayLockError(
        "another gateway instance is already listening on ws://127.0.0.1:18789",
      );
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });

    await expect(
      testing.runGatewayLoopWithSupervisedLockRecovery({
        startLoop,
        supervisor: "systemd",
        port: 18789,
        healthHost: "127.0.0.1",
        log: createLogger(),
        probeStartup: vi.fn(async () => false),
        now: () => now,
        sleep,
        retryMs: 5,
        timeoutMs: 12,
      }),
    ).rejects.toThrow(
      "gateway already running under systemd; existing gateway did not become healthy after 12ms",
    );

    expect(startLoop).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 5);
    expect(sleep).toHaveBeenNthCalledWith(3, 2);
  });

  it.each(["gateway already running", "another gateway instance is already listening"])(
    "uses exit 1 for unmanaged lock errors: %s",
    (message) => {
      expect(testing.resolveGatewayLockErrorExitCode(new GatewayLockError(message))).toBe(1);
    },
  );

  it("retries non-mutating TLS fingerprint loads until certificate material is ready", async () => {
    loadGatewayTlsRuntimeMock.mockClear();
    const probeStartup = testing.createConfiguredGatewayStartupProbe({
      gateway: { tls: { enabled: true, autoGenerate: true } },
    });

    await expect(probeStartup({ host: "127.0.0.1", port: 18789 })).resolves.toBe(false);
    await expect(probeStartup({ host: "127.0.0.1", port: 18789 })).resolves.toBe(false);

    expect(loadGatewayTlsRuntimeMock).toHaveBeenCalledTimes(2);
    expect(loadGatewayTlsRuntimeMock).toHaveBeenNthCalledWith(1, {
      enabled: true,
      autoGenerate: false,
    });
    expect(loadGatewayTlsRuntimeMock).toHaveBeenNthCalledWith(2, {
      enabled: true,
      autoGenerate: false,
    });
  });

  it("recognizes only the OpenClaw started response", () => {
    expect(
      testing.isGatewayStartupzResponse(200, JSON.stringify({ ok: true, status: "started" })),
    ).toBe(true);
    expect(
      testing.isGatewayStartupzResponse(200, JSON.stringify({ ok: true, status: "live" })),
    ).toBe(false);
    expect(
      testing.isGatewayStartupzResponse(503, JSON.stringify({ ok: false, status: "draining" })),
    ).toBe(false);
    expect(testing.isGatewayStartupzResponse(404, "not found")).toBe(false);
    expect(testing.isGatewayStartupzResponse(200, "not json")).toBe(false);
  });

  it("bounds slow startup responses with an absolute deadline", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const interval = setInterval(() => {
        res.write(" ");
      }, 10);
      res.once("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const startedAt = Date.now();
      await expect(
        testing.probeGatewayStartupz({
          host: "127.0.0.1",
          port: address.port,
          timeoutMs: 50,
        }),
      ).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("uses the startup lifecycle probe for supervised recovery", async () => {
    let requestUrl: string | undefined;
    const server = createServer((req, res) => {
      requestUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "started" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      await expect(
        testing.probeGatewayStartupz({ host: "127.0.0.1", port: address.port }),
      ).resolves.toBe(true);
      expect(requestUrl).toBe("/startupz");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("normalizes wildcard bind hosts for local startup probes", () => {
    expect(testing.normalizeGatewayStartupProbeHost("0.0.0.0")).toBe("127.0.0.1");
    expect(testing.normalizeGatewayStartupProbeHost("::")).toBe("127.0.0.1");
    expect(testing.normalizeGatewayStartupProbeHost("127.0.0.1")).toBe("127.0.0.1");
  });
});
