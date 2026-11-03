import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  makeUserInput,
  outputItem,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

describe("qa mock openai server", () => {
  it.each([
    [
      "plans QA tool-search calls for instruction-declared Codex dynamic tools",
      {
        instructions: "Codex dynamic OpenClaw tools available in this turn: web_search.",
        input: [
          makeUserInput(
            "tool search qa check target=web_search. Call exactly that tool once and then summarize.",
          ),
        ],
      },
      "web_search",
      "OpenClaw runtime parity fixed query",
    ],
    [
      "plans QA tool-search calls from explicit fixture targets even without Responses tools",
      {
        input: [
          makeUserInput(
            "tool search qa check target=session_status. Call exactly that tool once and then summarize.",
          ),
        ],
      },
      "session_status",
      "current",
    ],
    [
      "plans QA tool-search failure calls with denied-input args",
      {
        input: [
          makeUserInput(
            "tool search qa failure target=web_search. Exercise the denied-input path once and then summarize.",
          ),
        ],
      },
      "web_search",
      "OPENCLAW_QA_WEB_SEARCH_DENIED_INPUT",
    ],
  ] as const)("%s", async (_name, body, tool, argument) => {
    const item = outputItem(await expectNonStreamingResponsesJson(await startMockServer(), body));
    expect(item.type).toBe("function_call");
    expect(item.name).toBe(tool);
    expect(String(item.arguments)).toContain(argument);
  });
});
