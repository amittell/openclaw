import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RespawnSupervisor } from "../../infra/supervisor-markers.js";
import "./run.js";

type GatewayRunTestLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type GatewayRunTestApi = {
  createConfiguredGatewayStartupProbe(
    cfg: OpenClawConfig,
  ): (params: { host: string; port: number }) => Promise<boolean>;
  isGatewayStartupzResponse(statusCode: number | undefined, body: string): boolean;
  normalizeGatewayStartupProbeHost(host: string): string;
  probeGatewayStartupz(params: {
    host: string;
    port: number;
    timeoutMs?: number;
    tlsFingerprint?: string;
  }): Promise<boolean>;
  resolveGatewayLockErrorExitCode(err: unknown): number;
  resolveGatewayStartupFailureExitCode(err: unknown): number;
  runGatewayLoopWithSupervisedLockRecovery(params: {
    startLoop: () => Promise<void>;
    supervisor: RespawnSupervisor | null;
    port: number;
    healthHost: string;
    log: GatewayRunTestLogger;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    probeStartup?: (params: { host: string; port: number }) => Promise<boolean>;
    retryMs?: number;
    timeoutMs?: number;
  }): Promise<void>;
};

function getTestApi(): GatewayRunTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.gatewayRunTestApi")
  ] as GatewayRunTestApi;
}

export const testing: GatewayRunTestApi = {
  createConfiguredGatewayStartupProbe(cfg) {
    return getTestApi().createConfiguredGatewayStartupProbe(cfg);
  },
  isGatewayStartupzResponse(statusCode, body) {
    return getTestApi().isGatewayStartupzResponse(statusCode, body);
  },
  normalizeGatewayStartupProbeHost(host) {
    return getTestApi().normalizeGatewayStartupProbeHost(host);
  },
  async probeGatewayStartupz(params) {
    return await getTestApi().probeGatewayStartupz(params);
  },
  resolveGatewayLockErrorExitCode(err) {
    return getTestApi().resolveGatewayLockErrorExitCode(err);
  },
  resolveGatewayStartupFailureExitCode(err) {
    return getTestApi().resolveGatewayStartupFailureExitCode(err);
  },
  async runGatewayLoopWithSupervisedLockRecovery(params) {
    await getTestApi().runGatewayLoopWithSupervisedLockRecovery(params);
  },
};
