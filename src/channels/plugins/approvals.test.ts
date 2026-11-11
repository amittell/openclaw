// Approval tests cover channel plugin approval request formatting and dispatch.
import { describe, expect, it, vi } from "vitest";
import { createApproverRestrictedNativeApprovalCapabilityAsync } from "../../plugin-sdk/approval-delivery-runtime.js";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "../../plugin-sdk/approval-handler-adapter-runtime.js";
import { resolveChannelApprovalAdapter, resolveChannelApprovalCapability } from "./approvals.js";
import { channelPluginHasNativeApprovalPromptUi } from "./native-approval-prompt.js";

function createNativeRuntimeStub() {
  return {
    availability: {
      isConfigured: vi.fn(),
      shouldHandle: vi.fn(),
    },
    presentation: {
      buildPendingPayload: vi.fn(),
      buildResolvedResult: vi.fn(),
      buildExpiredResult: vi.fn(),
    },
    transport: {
      prepareTarget: vi.fn(),
      deliverPending: vi.fn(),
    },
  };
}

describe("resolveChannelApprovalCapability", () => {
  it("returns undefined when approvalCapability is absent", () => {
    expect(resolveChannelApprovalCapability({})).toBeUndefined();
  });

  it("returns approvalCapability as the canonical approval contract", () => {
    const capabilityAuth = vi.fn();
    const capabilityAvailability = vi.fn();
    const capabilityNativeRuntime = createNativeRuntimeStub();
    const delivery = { hasConfiguredDmRoute: vi.fn() };

    expect(
      resolveChannelApprovalCapability({
        approvalCapability: {
          authorizeActorAction: capabilityAuth,
          getActionAvailabilityState: capabilityAvailability,
          delivery,
          nativeRuntime: capabilityNativeRuntime,
        },
      }),
    ).toEqual({
      authorizeActorAction: capabilityAuth,
      getActionAvailabilityState: capabilityAvailability,
      delivery,
      nativeRuntime: capabilityNativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});

describe("resolveChannelApprovalAdapter", () => {
  it("returns only delivery/runtime surfaces from approvalCapability", () => {
    const delivery = { hasConfiguredDmRoute: vi.fn() };
    const nativeRuntime = createNativeRuntimeStub();
    const describeExecApprovalSetup = vi.fn();
    const describePluginApprovalSetup = vi.fn();

    expect(
      resolveChannelApprovalAdapter({
        approvalCapability: {
          describeExecApprovalSetup,
          describePluginApprovalSetup,
          delivery,
          nativeRuntime,
          authorizeActorAction: vi.fn(),
        },
      }),
    ).toEqual({
      describeExecApprovalSetup,
      describePluginApprovalSetup,
      delivery,
      nativeRuntime,
      render: undefined,
      native: undefined,
    });
  });
});

describe("channelPluginHasNativeApprovalPromptUi", () => {
  it("recognizes native approval UI from the async approval factories", () => {
    const nativeRuntimeAsync = createLazyChannelApprovalNativeRuntimeAdapterAsync({
      capabilityBoundary: true,
      isConfigured: async () => true,
      shouldHandle: async () => true,
      load: async () => {
        throw new Error("not loaded by prompt capability checks");
      },
    });
    const approvalCapability = createApproverRestrictedNativeApprovalCapabilityAsync({
      channel: "chat",
      channelLabel: "Chat",
      listAccountIds: () => ["default"],
      hasApprovers: () => true,
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled: async () => true,
      resolveNativeDeliveryMode: () => "dm",
      resolveApproverDmTargets: async () => [{ to: "owner" }],
    });

    expect(channelPluginHasNativeApprovalPromptUi({ approvalCapability })).toBe(true);
    expect(
      channelPluginHasNativeApprovalPromptUi({ approvalCapability: { nativeRuntimeAsync } }),
    ).toBe(true);
    expect(
      channelPluginHasNativeApprovalPromptUi({
        approvalCapability: {
          authorizeActorActionAsync: approvalCapability.authorizeActorActionAsync,
        },
      }),
    ).toBe(false);
  });
});
