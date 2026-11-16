// Fork coverage split out of server.test.ts to keep that file at its line cap.
import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  makeUserInput,
  postResponses,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();
const SESSIONS_SPAWN_TOOL = { type: "function", name: "sessions_spawn" } as const;

describe("qa mock openai server thread memory", () => {
  it("answers NONE without spawning when memory is unavailable and sessions_spawn is declared", async () => {
    const server = await startMockServer();
    const declaredToolThreadMemorySummary = await postResponses(server, {
      stream: false,
      tools: [SESSIONS_SPAWN_TOOL],
      input: [
        {
          role: "system",
          content: "## /workspace/MEMORY.md\nThread-hidden codename: ORBIT-22.",
        },
        makeUserInput(
          "@openclaw Thread memory check: what is the hidden thread codename stored only in memory? Use memory tools first and reply only in this thread.",
        ),
        {
          type: "function_call",
          name: "memory_search",
          arguments: JSON.stringify({
            query: "hidden thread codename ORBIT-22",
            maxResults: 3,
          }),
        },
        {
          type: "function_call_output",
          output: JSON.stringify({
            results: [],
            unavailable: true,
            error: "database is not open",
          }),
        },
      ],
    });
    expect(declaredToolThreadMemorySummary.status).toBe(200);
    const declaredToolThreadMemoryText = JSON.stringify(
      await declaredToolThreadMemorySummary.json(),
    );
    expect(declaredToolThreadMemoryText).toContain("NONE");
    expect(declaredToolThreadMemoryText).not.toContain("ORBIT-22");
    expect(declaredToolThreadMemoryText).not.toContain("sessions_spawn failed");
  });
});
