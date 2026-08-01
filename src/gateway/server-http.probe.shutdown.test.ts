// Shutting-down probe tests: live probes (/health, /healthz) flip to 503 the
// moment the gateway starts shutting down so supervised lock recovery
// distinguishes a draining gateway from a zombie that lost its close path.
// Split out of server-http.probe.test.ts (which sits at the test max-lines
// budget) to keep both files under the gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import { markGatewayShuttingDown, resetGatewayShuttingDownForTest } from "./gateway-shutdown-state.js";
import { resetGatewayHealthzShuttingDownLogForTest } from "./server-http.js";
import {
  AUTH_NONE,
  createRequest,
  createResponse,
  dispatchRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

const gatewayProbeWarn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      if (args[0] !== "gateway/probe") {
        return logger;
      }
      return new Proxy(logger, {
        get(target, property, receiver) {
          return property === "warn" ? gatewayProbeWarn : Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

afterEach(() => {
  resetGatewayShuttingDownForTest();
  resetGatewayHealthzShuttingDownLogForTest();
  gatewayProbeWarn.mockClear();
});

describe("gateway probe endpoints: shutting-down 503", () => {
  it("returns 503 on /healthz?strict=1 when the gateway is shutting down", async () => {
    await withGatewayServer({
      prefix: "probe-healthz-shutting-down",
      resolvedAuth: AUTH_NONE,
      overrides: { getShuttingDown: () => true },
      run: async (server) => {
        const req = createRequest({ path: "/healthz?strict=1" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ live: false, phase: "shutting_down" });
      },
    });
  });

  it("returns 503 on /health?strict=1 when the gateway is shutting down", async () => {
    await withGatewayServer({
      prefix: "probe-health-shutting-down",
      resolvedAuth: AUTH_NONE,
      overrides: { getShuttingDown: () => true },
      run: async (server) => {
        const req = createRequest({ path: "/health?strict=1" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ live: false, phase: "shutting_down" });
      },
    });
  });

  it("respects the module-level shutting-down flag with ?strict=1 and no injected getter", async () => {
    await withGatewayServer({
      prefix: "probe-healthz-module-flag",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        markGatewayShuttingDown();
        const req = createRequest({ path: "/healthz?strict=1" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(JSON.parse(getBody())).toEqual({ live: false, phase: "shutting_down" });
      },
    });
  });

  it("returns shutting-down HEAD /healthz?strict=1 without a body but with 503", async () => {
    await withGatewayServer({
      prefix: "probe-healthz-head-shutting-down",
      resolvedAuth: AUTH_NONE,
      overrides: { getShuttingDown: () => true },
      run: async (server) => {
        const req = createRequest({ path: "/healthz?strict=1", method: "HEAD" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(503);
        expect(getBody()).toBe("");
      },
    });
  });

  // Strict mode preserves backwards compatibility for external monitors and
  // service managers hitting the plain /healthz path.
  it("returns 200 on plain /healthz even when shutting down (public probe contract)", async () => {
    await withGatewayServer({
      prefix: "probe-healthz-shutting-down-no-strict",
      resolvedAuth: AUTH_NONE,
      overrides: { getShuttingDown: () => true },
      run: async (server) => {
        const req = createRequest({ path: "/healthz" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ok: true, status: "live" });
      },
    });
  });

  it("returns 200 on plain /health even when shutting down (public probe contract)", async () => {
    await withGatewayServer({
      prefix: "probe-health-shutting-down-no-strict",
      resolvedAuth: AUTH_NONE,
      overrides: { getShuttingDown: () => true },
      run: async (server) => {
        const req = createRequest({ path: "/health" });
        const { res, getBody } = createResponse();
        await dispatchRequest(server, req, res);

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(getBody())).toEqual({ ok: true, status: "live" });
      },
    });
  });

  // Each new shutdown cycle must emit the shutdown signal exactly once.
  it("resets the shutting-down probe log dedupe on each shutdown cycle", async () => {
    await withGatewayServer({
      prefix: "probe-healthz-strict-dedupe-cycles",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        // First shutdown cycle.
        markGatewayShuttingDown();
        const req1 = createRequest({ path: "/healthz?strict=1" });
        const { res: res1 } = createResponse();
        await dispatchRequest(server, req1, res1);
        expect(res1.statusCode).toBe(503);
        expect(gatewayProbeWarn).toHaveBeenCalledTimes(1);
        expect(gatewayProbeWarn).toHaveBeenLastCalledWith(
          expect.stringContaining("gateway.healthz.shutting_down_response path=/healthz"),
        );

        // Second probe in the SAME shutdown cycle should not emit again (dedupe).
        // Repeated close-path marking must be idempotent too.
        markGatewayShuttingDown();
        const req1b = createRequest({ path: "/healthz?strict=1" });
        const { res: res1b } = createResponse();
        await dispatchRequest(server, req1b, res1b);
        expect(res1b.statusCode).toBe(503);
        expect(gatewayProbeWarn).toHaveBeenCalledTimes(1);

        // Simulate startup completing a new cycle, then a fresh shutdown.
        resetGatewayShuttingDownForTest();
        markGatewayShuttingDown();
        const req2 = createRequest({ path: "/healthz?strict=1" });
        const { res: res2 } = createResponse();
        await dispatchRequest(server, req2, res2);
        expect(res2.statusCode).toBe(503);
        expect(gatewayProbeWarn).toHaveBeenCalledTimes(2);
      },
    });
  });
});