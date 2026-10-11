import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { buildEmbeddedRunPayloads } from "../agents/embedded-agent-runner/run/payloads.js";
import { handleAgentEnd } from "../agents/embedded-agent-subscribe.handlers.lifecycle.js";
import { createContext } from "../agents/embedded-agent-subscribe.handlers.lifecycle.test-helpers.js";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";

// mock-isolation: Native lifecycle projection must not read an operator's session store.
vi.mock("./session-utils.js", () => {
  const loadSessionEntry = vi.fn(() => ({
    cfg: {},
    storePath: "/tmp/native-provider-error-sessions.json",
    store: {},
    entry: undefined,
    canonicalKey: "session-native-provider-error",
    storeKeys: ["session-native-provider-error"],
  }));
  return { loadSessionEntry, loadGatewaySessionEntryReadOnly: loadSessionEntry };
});

afterEach(() => vi.useRealTimers());

it("preserves exhausted context-budget guidance in live chat, Details, history, and channel replies", async () => {
  vi.useFakeTimers();
  const assistant = makeAssistantMessageFixture({
    provider: "lmstudio",
    model: "local-model",
    content: [],
    errorCode: "context_length_exceeded",
    errorMessage:
      "Context window exceeded: estimated input 35137 leaves only 0 output tokens within the 32768-token context.",
  });
  const expected =
    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
  const broadcast = vi.fn();
  const chatRunState = createChatRunState();
  const handler = createAgentEventHandler({
    broadcast,
    broadcastToConnIds: vi.fn(),
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => true,
    agentRunSeq: new Map(),
    chatRunState,
    resolveSessionKeyForRun: () => undefined,
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
    persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
    lifecycleErrorRetryGraceMs: 0,
  });
  onTestFinished(() => handler.dispose());
  const ctx = createContext(assistant);
  const runId = ctx.params.runId;
  const sessionKey = "agent:main:main";
  registerChatRun(chatRunState, runId, sessionKey, runId);
  const deliveries: Promise<void>[] = [];
  ctx.params.onAgentEvent = (event) => {
    deliveries.push(Promise.resolve(emitAgentEvent(handler, runId, event.stream, event.data)));
  };
  await handleAgentEnd(ctx);
  await Promise.all(deliveries);

  const terminals = broadcast.mock.calls.filter(
    ([event, payload]) => event === "chat" && payload.state !== "delta",
  );
  expect(terminals).toHaveLength(1);
  expect(terminals[0]?.[1]).toMatchObject({
    state: "error",
    errorMessage: expected,
    errorDetail: { failoverReason: "context_overflow" },
  });
  const history = projectChatDisplayMessages([assistant]);
  expect(history).toHaveLength(1);
  expect(history[0]?.content).toEqual([{ type: "text", text: expected }]);
  expect(history[0]).not.toHaveProperty("errorMessage");
  expect(
    buildEmbeddedRunPayloads({ assistantTexts: [], lastAssistant: assistant, sessionKey }),
  ).toMatchObject([{ text: expected, isError: true }]);
});
