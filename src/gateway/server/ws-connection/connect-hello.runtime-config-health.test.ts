// Fork carry (#89526): hello's runtime-config health. Upstream dropped these cases with
// connect-hello.update-scope.test.ts in #198943; the behavior they cover is fork-only.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { closedObject } from "../../../../packages/gateway-protocol/src/schema/closed-object.js";
import type { HelloOk } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import { SnapshotSchema } from "../../../../packages/gateway-protocol/src/schema/snapshot.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";

type HelloHealth = HelloOk["snapshot"]["health"];

const { getHealthCacheMock, readCurrentRuntimeConfigHealthMock, redeemBootstrapMock } = vi.hoisted(
  () => ({
    getHealthCacheMock: vi.fn<() => HelloHealth | null>(() => null),
    readCurrentRuntimeConfigHealthMock: vi.fn<() => HelloHealth["runtimeConfig"]>(() => undefined),
    redeemBootstrapMock: vi.fn(async () => ({ fullyRedeemed: false })),
  }),
);

// mock-isolation: The health owner keeps a process-wide cache; hello must read this fixture's.
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
  })),
  getHealthCache: getHealthCacheMock,
  getHealthVersion: vi.fn(() => 1),
  readCurrentRuntimeConfigHealth: readCurrentRuntimeConfigHealthMock,
}));

// mock-isolation: Bootstrap redemption mutates the device pairing store; keep it out of here.
vi.mock("../../../infra/device-bootstrap.js", () => ({
  redeemDeviceBootstrapTokenProfile: redeemBootstrapMock,
  restoreGenericDeviceBootstrapToken: vi.fn(async () => undefined),
}));

vi.mock("../../../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-profile-list.js")>()),
  hasMultipleResidentSessionSharingIdentities: vi.fn(() => false),
}));

// mock-isolation: Plugin descriptors come from the process-wide plugin registry; hello needs none.
vi.mock("../../control-ui-plugin-tabs.js", () => ({
  listControlUiLinkReaders: vi.fn(() => []),
  listControlUiPluginTabs: vi.fn(() => []),
  listControlUiPluginWidgetKinds: vi.fn(() => []),
}));

// mock-isolation: Synthetic hellos must not write to the security event journal.
vi.mock("./connect-auth-security.js", () => ({ emitGatewayAuthSecurityEvent: vi.fn() }));

import { sendGatewayHello } from "./connect-hello.js";

const RUNTIME_CONFIG_CAPS = [GATEWAY_CLIENT_CAPS.RUNTIME_CONFIG_HEALTH];

function drift(driftPaths: string[]) {
  return {
    state: "drift" as const,
    driftPaths,
    message:
      "Live gateway runtime config differs from the latest completed reload observation; restart is required.",
  };
}

function publishedHealth(runtimeConfig: HelloHealth["runtimeConfig"]): HelloHealth {
  return {
    ok: true,
    ts: 1,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "sessions.db", count: 0, recent: [] },
    runtimeConfig,
  };
}

// The strict v4 snapshot decoder that shipped before runtimeConfig existed.
function preChangeV4SnapshotSchema() {
  const health = Object.fromEntries(
    Object.entries(SnapshotSchema.properties.health.properties).filter(
      ([key]) => key !== "runtimeConfig",
    ),
  );
  return closedObject({ ...SnapshotSchema.properties, health: closedObject(health) });
}

function makeContext(scopes: string[], caps?: string[]) {
  return {
    handler: {
      getClient: () => null,
      connId: "conn-operator",
      ingressAttribution: { kind: "direct-local" },
      gatewayMethods: [],
      events: [],
      buildRequestContext: () => ({}),
      refreshHealthSnapshot: vi.fn(async () => ({})),
      close: vi.fn(),
      advanceHandshakePhase: vi.fn(),
      setCloseCause: vi.fn(),
      logGateway: { warn: vi.fn() },
      logHealth: { error: vi.fn() },
    },
    frame: { id: "hello-operator" },
    connectParams: {
      client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
      role: "operator",
      scopes,
      ...(caps ? { caps } : {}),
    },
    configSnapshot: {},
    sendFrame: vi.fn(async (_frame: { payload?: HelloOk }) => undefined),
    onHelloDelivered: vi.fn(),
    pendingNodePairingCleanup: {},
    releasePendingNodePairingCleanup: vi.fn(async () => undefined),
  };
}

function makeState(scopes: string[]) {
  return {
    resolvedAuth: { mode: "none" },
    role: "operator",
    scopes,
    device: null,
    hasTokenAuth: false,
    hasPasswordAuth: false,
    authResult: { ok: true, method: "none" },
    authMethod: "none",
    issuedBootstrapProfile: null,
    handoffBootstrapProfile: null,
    deviceToken: null,
    bootstrapDeviceTokens: [],
  };
}

function helloSnapshot(context: ReturnType<typeof makeContext>) {
  return context.sendFrame.mock.calls[0]?.[0].payload?.snapshot;
}

describe("sendGatewayHello runtime-config health", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("includes the synchronously current shared health publication before passive refresh", async () => {
    getHealthCacheMock.mockReturnValue(publishedHealth(drift(["gateway.auth"])));
    const context = makeContext(["operator.admin"], RUNTIME_CONFIG_CAPS);

    await sendGatewayHello(context as never, makeState(["operator.admin"]) as never, {});

    expect(helloSnapshot(context)?.health.runtimeConfig).toEqual(drift(["gateway.auth"]));
    expect(helloSnapshot(context)?.health.runtimeConfig).not.toHaveProperty(
      "liveSourceFingerprint",
    );
    expect(helloSnapshot(context)?.health.runtimeConfig).not.toHaveProperty(
      "observedSourceFingerprint",
    );
    expect(getHealthCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(context.sendFrame.mock.invocationCallOrder[0]).toBeLessThan(
      context.handler.refreshHealthSnapshot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("projects current config health when observation invalidation clears the full cache", async () => {
    readCurrentRuntimeConfigHealthMock.mockReturnValue(drift(["agents.entries"]));
    const context = makeContext(["operator.read"], RUNTIME_CONFIG_CAPS);

    await sendGatewayHello(context as never, makeState(["operator.read"]) as never, {});

    expect(helloSnapshot(context)?.health.runtimeConfig).toEqual(drift(["agents.entries"]));
    expect(getHealthCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(context.sendFrame.mock.invocationCallOrder[0]).toBeLessThan(
      context.handler.refreshHealthSnapshot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("finalizes config health after awaited bootstrap bookkeeping", async () => {
    const oldHealth = publishedHealth({ state: "ok" });
    const redemptionStarted = createDeferred();
    const releaseRedemption = createDeferred();
    redeemBootstrapMock.mockImplementationOnce(async () => {
      redemptionStarted.resolve();
      await releaseRedemption.promise;
      return { fullyRedeemed: false };
    });
    getHealthCacheMock.mockReturnValue(oldHealth);
    const context = makeContext(["operator.read"], RUNTIME_CONFIG_CAPS);
    const state = {
      ...makeState(["operator.read"]),
      device: { id: "device-a" },
      devicePublicKey: "public-key-a",
      bootstrapTokenCandidate: "bootstrap-a",
      authResult: { ok: true, method: "bootstrap-token" },
      authMethod: "bootstrap-token",
      issuedBootstrapProfile: { kind: "test" },
    };

    const hello = sendGatewayHello(context as never, state as never, {});
    await awaitGateBeforeSettlement(
      redemptionStarted.promise,
      hello,
      "hello settled before bootstrap redemption started",
    );
    getHealthCacheMock.mockReturnValue(null);
    readCurrentRuntimeConfigHealthMock.mockReturnValue(drift(["agents.entries"]));
    releaseRedemption.resolve();
    await hello;

    expect(helloSnapshot(context)?.health).toEqual({ runtimeConfig: drift(["agents.entries"]) });
    expect(helloSnapshot(context)?.health).not.toMatchObject(oldHealth);
    expect(getHealthCacheMock).toHaveBeenCalledOnce();
    expect(readCurrentRuntimeConfigHealthMock.mock.invocationCallOrder[0]).toBeLessThan(
      context.sendFrame.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("sends runtimeConfig only to clients that advertise runtime-config-health", async () => {
    const runtimeConfig = {
      state: "drift" as const,
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
      driftPaths: ["agents.defaults.model"],
      message:
        "Live gateway runtime config differs from the latest completed reload observation for model/provider/auth paths; restart is required or pending.",
    };
    const cachedHealth = publishedHealth(runtimeConfig);
    const hello = async (caps?: string[]) => {
      const context = makeContext(["operator.read"], caps);
      await sendGatewayHello(context as never, makeState(["operator.read"]) as never, {});
      return helloSnapshot(context);
    };
    const preChangeV4 = preChangeV4SnapshotSchema();

    getHealthCacheMock.mockReturnValue(cachedHealth);
    const cachedLegacy = await hello();
    const cachedAdvertised = await hello(RUNTIME_CONFIG_CAPS);
    getHealthCacheMock.mockReturnValue(null);
    readCurrentRuntimeConfigHealthMock.mockReturnValue(runtimeConfig);
    const projectedLegacy = await hello();
    const projectedAdvertised = await hello(RUNTIME_CONFIG_CAPS);

    // A client that does not advertise the capability gets the pre-change shape,
    // which a strict v4 decoder built before runtimeConfig existed accepts.
    expect(Value.Check(preChangeV4, cachedLegacy)).toBe(true);
    expect(Value.Check(preChangeV4, projectedLegacy)).toBe(true);
    expect(cachedLegacy?.health).not.toHaveProperty("runtimeConfig");
    expect(projectedLegacy?.health).toEqual({});
    expect(readCurrentRuntimeConfigHealthMock).toHaveBeenCalledOnce();
    expect(cachedHealth.runtimeConfig).toBe(runtimeConfig);
    // The advertising client keeps the diagnostic under the current schema; the
    // pre-change decoder rejects exactly that, which is why it is gated.
    for (const snapshot of [cachedAdvertised, projectedAdvertised]) {
      expect(snapshot?.health.runtimeConfig).toEqual(runtimeConfig);
      expect(Value.Check(SnapshotSchema, snapshot)).toBe(true);
      expect(Value.Check(preChangeV4, snapshot)).toBe(false);
    }
  });
});
