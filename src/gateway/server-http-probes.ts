import type { IncomingMessage, ServerResponse } from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { authorizeHttpGatewayConnect, isLocalDirectRequest } from "./auth.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { classifyGatewayProbePath } from "./gateway-http-route-contracts.js";
import { isGatewayShuttingDown } from "./server-close.js";
import type { ReadinessChecker, StartupChecker, StartupResult } from "./server/readiness.js";

const getHttpAuthUtilsModule = createLazyRuntimeModule(() => import("./http-auth-utils.js"));

const gatewayProbeLog = createSubsystemLogger("gateway/probe");
// Logging the shutting-down 503 response once per shutdown sequence is enough to
// trace the zombie cascade; bursts add noise without value because every callers'
// probe round-trips during the same window.
let shuttingDownResponseLogged = false;
export function noteShuttingDownProbeResponse(requestPath: string): void {
  if (shuttingDownResponseLogged) {
    return;
  }
  shuttingDownResponseLogged = true;
  gatewayProbeLog.warn(
    `gateway.healthz.shutting_down_response path=${requestPath}; returning 503 so supervised lock recovery treats this gateway as draining`,
  );
}
export function resetGatewayHealthzShuttingDownLogForTest(): void {
  shuttingDownResponseLogged = false;
}


async function shouldIncludeGatewayProbeDetails(params: {
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) {
    return true;
  }
  if (params.resolvedAuth.mode === "none") {
    return false;
  }
  const { getBearerToken, resolveHttpBrowserOriginPolicy } = await getHttpAuthUtilsModule();
  const bearerToken = getBearerToken(params.req);
  return (
    await authorizeHttpGatewayConnect({
      auth: params.resolvedAuth,
      connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
      req: params.req,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req),
    })
  ).ok;
}

function startupProbeBody(result: StartupResult, includeDetails: boolean): string {
  if (!includeDetails) {
    return JSON.stringify({ ok: result.ok, status: result.status });
  }
  return JSON.stringify({
    ok: result.ok,
    status: result.status,
    version: resolveRuntimeServiceVersion(process.env),
    uptimeMs: result.uptimeMs,
    ...(result.status === "starting" ? { pendingReason: result.pendingReason } : {}),
  });
}

/** Handles live/ready/startup probe endpoints before normal gateway routing. */
export async function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  resolvedAuth: ResolvedGatewayAuth,
  trustedProxies: string[],
  allowRealIpFallback: boolean,
  getReadiness?: ReadinessChecker,
  getStartup?: StartupChecker,
  getShuttingDown: () => boolean = isGatewayShuttingDown,
): Promise<boolean> {
  const status = classifyGatewayProbePath(requestPath);
  if (status === "namespace" || status === "outside") {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  let statusCode: number;
  let body: string;
  // Live probes flip to 503 the moment shutdown starts so supervised lock
  // recovery distinguishes a healthy gateway from a zombie that still holds
  // the HTTP listener. The flag is owned by `server-close` and is set before
  // any close-handler await.
  if (status === "live" && getShuttingDown()) {
    noteShuttingDownProbeResponse(requestPath);
    statusCode = 503;
    body = JSON.stringify({ live: false, phase: "shutting_down" });
  } else if (status === "ready" && getReadiness) {
    // Readiness details expose subsystem names, so only local direct or authenticated
    // callers receive them; unauthenticated remote probes get the aggregate boolean.
    const includeDetails = await shouldIncludeGatewayProbeDetails({
      req,
      resolvedAuth,
      trustedProxies,
      allowRealIpFallback,
    });
    try {
      const result = getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(includeDetails ? result : { ready: result.ready });
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { ready: false, failing: ["internal"], uptimeMs: 0 } : { ready: false },
      );
    }
  } else if (status === "startup") {
    const includeDetails = await shouldIncludeGatewayProbeDetails({
      req,
      resolvedAuth,
      trustedProxies,
      allowRealIpFallback,
    });
    try {
      const result = getStartup?.() ?? { ok: true, status: "started", uptimeMs: 0 };
      statusCode = result.ok ? 200 : 503;
      body = startupProbeBody(result, includeDetails);
    } catch {
      const result: StartupResult = {
        ok: false,
        status: "starting",
        uptimeMs: 0,
        pendingReason: "internal",
      };
      statusCode = 503;
      body = startupProbeBody(result, includeDetails);
    }
  } else {
    statusCode = 200;
    body = JSON.stringify({ ok: true, status });
  }
  res.statusCode = statusCode;
  // Node suppresses the HEAD body but never synthesizes Content-Length; set it
  // explicitly so probes keep GET/HEAD header parity (RFC 9110 §8.6).
  res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  res.end(method === "HEAD" ? undefined : body);
  return true;
}
