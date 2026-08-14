import { describe, expect, it } from "vitest";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";
import type { ReadinessChecker } from "./server/readiness.js";

describe("strict gateway liveness", () => {
  it("rejects a draining predecessor without inheriting channel readiness", async () => {
    let failing = ["gateway-draining"];
    const getReadiness: ReadinessChecker = () => ({ ready: false, failing, uptimeMs: 999 });

    await withGatewayServer({
      prefix: "probe-healthz-strict-draining",
      resolvedAuth: AUTH_NONE,
      overrides: { getReadiness },
      run: async (server) => {
        const draining = await sendRequest(server, { path: "/healthz?strict=1" });
        expect(draining.res.statusCode).toBe(503);
        expect(JSON.parse(draining.getBody())).toEqual({
          live: false,
          phase: "shutting_down",
        });

        failing = ["discord"];
        const unrelatedFailure = await sendRequest(server, { path: "/healthz?strict=1" });
        expect(unrelatedFailure.res.statusCode).toBe(200);
        expect(JSON.parse(unrelatedFailure.getBody())).toEqual({ ok: true, status: "live" });
      },
    });
  });
});
