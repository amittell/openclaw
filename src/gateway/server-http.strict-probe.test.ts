import { describe, expect, it } from "vitest";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";
import type { ReadinessChecker, StartupChecker } from "./server/readiness.js";

describe("strict gateway liveness", () => {
  it("follows startup lifecycle instead of aggregate readiness", async () => {
    let draining = true;
    let failing = ["discord"];
    const getReadiness: ReadinessChecker = () => ({ ready: false, failing, uptimeMs: 999 });
    const getStartup: StartupChecker = () =>
      draining
        ? { ok: false, status: "draining", uptimeMs: 999 }
        : { ok: true, status: "started", uptimeMs: 999 };

    await withGatewayServer({
      prefix: "probe-healthz-strict-draining",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness, getStartup },
      run: async (server) => {
        const drainingResponse = await sendRequest(server, { path: "/healthz?strict=1" });
        expect(drainingResponse.res.statusCode).toBe(503);
        expect(JSON.parse(drainingResponse.getBody())).toEqual({
          live: false,
          phase: "shutting_down",
        });

        draining = false;
        failing = ["gateway-draining"];
        const started = await sendRequest(server, { path: "/healthz?strict=1" });
        expect(started.res.statusCode).toBe(200);
        expect(JSON.parse(started.getBody())).toEqual({ ok: true, status: "live" });
      },
    });
  });
});
