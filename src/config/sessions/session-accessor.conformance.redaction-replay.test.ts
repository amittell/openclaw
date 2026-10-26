import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publicAccessorAdapter,
  sqliteAdapter,
  type TestPaths,
} from "./session-accessor.conformance-adapters.test-support.js";
import { closeSessionAccessorConformanceFixture } from "./session-accessor.conformance.test-support.js";

// Keep accessor conformance independent of any real openclaw.json on the machine.
vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

import { getRuntimeConfig } from "../config.js";

beforeEach(() => {
  vi.mocked(getRuntimeConfig).mockReturnValue({});
});

afterEach(() => {
  vi.mocked(getRuntimeConfig).mockReset();
});

describe.each([publicAccessorAdapter, sqliteAdapter])(
  "session accessor conformance: $name",
  (adapter) => {
    let paths: TestPaths;

    beforeEach(() => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-conf-"));
      paths = {
        sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
        stateDir: path.join(tempDir, "state"),
        storePath: path.join(tempDir, "sessions.json"),
        tempDir,
      };
    });

    afterEach(async () => {
      await closeSessionAccessorConformanceFixture(paths.tempDir);
    });

    it("replays a keyed user turn whose stored copy a second redaction pass would change", async () => {
      // Upstream #169154: the first storage pass hints a bearer token and a second pass masks it,
      // so the run's copy of an admitted user turn could never match its stored copy.
      const scope = adapter.transcriptScope(paths, "session-redaction-replay");
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-1" })}.${"A1b2C3d4".repeat(3)}`;
      const appended = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: `log line Authorization: Bearer ${jwt} status=200`,
          idempotencyKey: "channel-user:v1:redaction-replay",
        },
      });
      const stored = appended?.message as { content?: unknown } | undefined;
      expect(stored?.content).not.toContain(jwt);

      const replayed = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: stored?.content,
          idempotencyKey: "channel-user:v1:redaction-replay",
        },
      });

      expect(replayed).toMatchObject({ appended: false, messageId: appended?.messageId });
      await expect(
        adapter.appendTranscriptMessage(scope, {
          cwd: paths.tempDir,
          idempotencyLookup: "scan",
          message: {
            role: "user",
            content: "a different message",
            idempotencyKey: "channel-user:v1:redaction-replay",
          },
        }),
      ).rejects.toThrow(/conflicts with the admitted message/u);
    });
  },
);
