// Pins which sessions a channel turn can reassign through the real in-process router and SQLite store:
// a non-owner turn only its own session and the sessions it spawned (fork rule on top of #154239),
// an owner turn any visible session.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";

// A group conversation on a single-user Gateway (no roles); its sender may or may not be an owner.
const REQUESTER = { agentId: "main", sessionKey: "agent:main:telegram:group:-100154239" };
const REQUESTER_ID = "non-owner-group-id";
const SPAWNED_CHILD = { agentId: "main", sessionKey: "agent:main:dashboard:spawned-child" };
const SAME_AGENT = { agentId: "main", sessionKey: "agent:main:telegram:direct:4242" };
const SAME_AGENT_ID = "same-agent-direct-id";
const OTHER_AGENT = { agentId: "other", sessionKey: "agent:other:telegram:direct:4242" };

type TargetName =
  | "current"
  | "currentByKey"
  | "currentBySessionId"
  | "spawnedChild"
  | "sameAgentKey"
  | "sameAgentSessionId"
  | "otherAgent";
const TARGETS: Record<TargetName, { session: typeof REQUESTER; sessionKey?: string }> = {
  current: { session: REQUESTER },
  currentByKey: { session: REQUESTER, sessionKey: REQUESTER.sessionKey },
  currentBySessionId: { session: REQUESTER, sessionKey: REQUESTER_ID },
  spawnedChild: { session: SPAWNED_CHILD, sessionKey: SPAWNED_CHILD.sessionKey },
  sameAgentKey: { session: SAME_AGENT, sessionKey: SAME_AGENT.sessionKey },
  sameAgentSessionId: { session: SAME_AGENT, sessionKey: SAME_AGENT_ID },
  otherAgent: { session: OTHER_AGENT, sessionKey: OTHER_AGENT.sessionKey },
};
const OWN_TREE = new Set<TargetName>([
  "current",
  "currentByKey",
  "currentBySessionId",
  "spawnedChild",
]);

// "non-owner" is the fork's non-owner rule; "visibility" is upstream's configured tool scope.
type Outcome = "allowed" | "non-owner" | "visibility";
const REFUSAL: Record<Exclude<Outcome, "allowed">, RegExp> = {
  "non-owner":
    /Non-owner callers can assign an owner only for the current session or a session it spawned/,
  visibility: /visibility is restricted\. Set tools\.sessions\.visibility=all/,
};

const VISIBILITY: Array<{ visibility: string; tools: OpenClawConfig["tools"] }> = [
  { visibility: "default (all)", tools: undefined },
  { visibility: "agent", tools: { sessions: { visibility: "agent" } } },
];

function expectedOutcome(senderIsOwner: boolean, visibility: string, target: TargetName): Outcome {
  if (visibility === "agent" && target === "otherAgent") {
    return "visibility";
  }
  return senderIsOwner || OWN_TREE.has(target) ? "allowed" : "non-owner";
}

let fixtureRun: Promise<void> | undefined;

function withChannelTurnFixture(
  tools: OpenClawConfig["tools"],
  run: (cfg: OpenClawConfig) => Promise<void>,
) {
  return (fixtureRun = withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: state.workspaceDir },
          other: { workspace: state.path("other-workspace") },
        },
      },
      ...(tools ? { tools } : {}),
    };
    await state.writeConfig(cfg);
    for (const [{ agentId, sessionKey }, sessionId] of [
      [REQUESTER, REQUESTER_ID],
      [SAME_AGENT, SAME_AGENT_ID],
      [OTHER_AGENT, "other-agent-direct-id"],
    ] as const) {
      await upsertSessionEntryCore({ agentId, sessionKey }, { sessionId, updatedAt: 1 });
    }
    // A child this conversation spawned, as sessions_spawn records it.
    await upsertSessionEntryCore(SPAWNED_CHILD, {
      sessionId: "spawned-child-id",
      updatedAt: 1,
      spawnedBy: REQUESTER.sessionKey,
      parentSessionKey: REQUESTER.sessionKey,
      spawnDepth: 1,
    });
    const resources = new LegacyPluginSdkResourceHost();
    try {
      await resources.run(() =>
        withLocalGatewayRequestScope(
          { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
          async () => {
            await getPluginRuntimeGatewayRequestScope()?.context?.ensureSessionRowProjection?.();
            return run(cfg);
          },
        ),
      );
    } finally {
      await resources.close();
    }
  }));
}

async function assignFromTurn(
  cfg: OpenClawConfig,
  senderIsOwner: boolean,
  target: TargetName,
  ownerId: string,
) {
  const tool = createSessionsTool({
    senderIsOwner,
    agentSessionKey: REQUESTER.sessionKey,
    config: cfg,
  });
  const { sessionKey } = TARGETS[target];
  // A live admitted agent turn, as a channel turn has; no operator authority.
  const runId = `${senderIsOwner ? "owner" : "non-owner"}-${target}`;
  const admission = prepareAgentRunAdmission({
    cfg,
    facts: {
      runId,
      agentId: REQUESTER.agentId,
      ingress: { kind: "system", boundary: "non-owner-assign-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  try {
    const admittedRunContext = await admission.admit("gateway", "non-owner-assign-test");
    return await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: REQUESTER.agentId,
        sessionKey: REQUESTER.sessionKey,
      }),
      () =>
        tool.execute(`assign-${target}`, {
          action: "assign_owner",
          ownerType: "agent",
          ownerId,
          ...(sessionKey ? { sessionKey } : {}),
        }),
    );
  } finally {
    admission.close();
  }
}

describe("sessions assign_owner reach from a channel turn", () => {
  let runtimeSetup: Promise<unknown>[] = [];
  beforeAll(() => {
    // Load the real resolve and mutation handlers before request deadlines begin.
    runtimeSetup = [
      import("./server-methods/sessions-mutations.js"),
      import("./server-methods/sessions-read.js"),
      import("./server-methods/sessions.runtime.js"),
    ];
    return Promise.all(runtimeSetup);
  });
  afterAll(async () => {
    await Promise.allSettled(runtimeSetup);
  });
  afterEach(async () => {
    await fixtureRun?.catch(() => {});
    fixtureRun = undefined;
  });

  it.each(
    VISIBILITY.flatMap(({ visibility, tools }) =>
      [false, true].map((senderIsOwner) => ({ visibility, tools, senderIsOwner })),
    ),
  )(
    "with visibility $visibility, senderIsOwner=$senderIsOwner reassigns only what the rule allows",
    async ({ visibility, tools, senderIsOwner }) => {
      await withChannelTurnFixture(tools, async (cfg) => {
        const outcomes: Record<string, Outcome> = {};
        for (const target of Object.keys(TARGETS) as TargetName[]) {
          const { session } = TARGETS[target];
          const before = loadSessionEntry(session)?.owner;
          // Alternate the assignee so every allowed call is an observable row change.
          const ownerId = before?.actor.id === "other" ? "main" : "other";
          const attempt = await assignFromTurn(cfg, senderIsOwner, target, ownerId).then(
            (result) => ({ ok: true as const, result }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (attempt.ok) {
            expect(attempt.result.details).toMatchObject({
              status: "updated",
              sessionKey: session.sessionKey,
              owner: { type: "agent", id: ownerId },
            });
            expect(loadSessionEntry(session)?.owner).toMatchObject({
              actor: { type: "agent", id: ownerId },
              assignedBy: { type: "agent", id: "main" },
            });
            outcomes[target] = "allowed";
            continue;
          }
          // A refusal must leave the row as it was, not refuse after the owner write.
          expect(loadSessionEntry(session)?.owner).toEqual(before);
          const message = String(attempt.error);
          outcomes[target] = REFUSAL["non-owner"].test(message)
            ? "non-owner"
            : REFUSAL.visibility.test(message)
              ? "visibility"
              : (message as Outcome);
        }
        expect(outcomes).toEqual(
          Object.fromEntries(
            (Object.keys(TARGETS) as TargetName[]).map((target) => [
              target,
              expectedOutcome(senderIsOwner, visibility, target),
            ]),
          ),
        );
      });
    },
  );
});
