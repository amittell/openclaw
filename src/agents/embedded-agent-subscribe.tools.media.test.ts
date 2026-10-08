import fs from "node:fs";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../channels/inbound-event/session-transcript-context.runtime.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
  recordToolResultLocalMediaReplayAuthorization,
} from "./embedded-agent-tool-media.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

describe("extractToolResultMediaArtifact", () => {
  it("stops structured media collection after the accepted limit", () => {
    let inspected = 0;
    const mediaUrls = Array.from({ length: 100_000 }, (_, index) => `/tmp/${index}.png`);

    expect(
      extractToolResultMediaArtifact(
        { details: { media: { mediaUrls } } },
        {
          maxMediaUrls: 64,
          acceptMediaUrl: () => {
            inspected += 1;
            return true;
          },
        },
      )?.mediaUrls,
    ).toEqual(mediaUrls.slice(0, 64));
    expect(inspected).toBe(64);
  });

  it.each([
    {
      label: "duplicate",
      mediaUrls: Array(100_000).fill("/tmp/repeated.png"),
      acceptMediaUrl: () => true,
      expected: ["/tmp/repeated.png"],
    },
    {
      label: "rejected",
      mediaUrls: Array.from({ length: 100_000 }, (_, index) => `/tmp/rejected-${index}.png`),
      acceptMediaUrl: () => false,
      expected: [],
    },
  ])("bounds raw $label structured media candidates", ({ mediaUrls, acceptMediaUrl, expected }) => {
    let inspected = 0;
    const iterateMediaUrls = mediaUrls[Symbol.iterator].bind(mediaUrls);
    Object.defineProperty(mediaUrls, Symbol.iterator, {
      *value() {
        for (const mediaUrl of iterateMediaUrls()) {
          inspected += 1;
          yield mediaUrl;
        }
      },
    });

    expect(
      extractToolResultMediaArtifact(
        { details: { media: { mediaUrls } } },
        { acceptMediaUrl, maxMediaCandidates: 64, maxMediaUrls: 64 },
      )?.mediaUrls,
    ).toEqual(expected);
    expect(inspected).toBe(64);
  });

  it("does not deliver explicitly private image results", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        details: { path: "/tmp/browser-screenshot.png", media: { outbound: false } },
      }),
    ).toBeUndefined();
  });

  it("aligns generated attachment metadata with deduplicated media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            mediaUrls: [" /tmp/song.mp3 ", "/tmp/cover.png", "/tmp/song.mp3"],
            audioAsVoice: true,
            trustedLocalMedia: true,
            attachments: [
              { type: "image", path: "/tmp/cover.png", name: "cover.png", width: 640, height: 480 },
              {
                type: "audio",
                path: "/tmp/song.mp3",
                name: "friendly-song.mp3",
                mimeType: "audio/mpeg",
                durationMs: 2_000,
                trustedLocalMedia: true,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/song.mp3", "/tmp/cover.png"],
      audioAsVoice: true,
      trustedLocalMedia: true,
      attachments: [
        {
          type: "audio",
          path: "/tmp/song.mp3",
          name: "friendly-song.mp3",
          mimeType: "audio/mpeg",
          durationMs: 2_000,
        },
        { type: "image", path: "/tmp/cover.png", name: "cover.png", width: 640, height: 480 },
      ],
    });
  });

  it("drops malformed metadata while preserving valid media references", () => {
    expect(
      extractToolResultMediaArtifact({
        details: {
          media: {
            attachments: [
              {
                type: "document",
                path: "/tmp/generated.mp3",
                url: false,
                mediaUrl: {},
                filePath: 12,
                mimeType: 7,
                name: 1,
                sizeBytes: Infinity,
                durationMs: -1,
                width: "1920",
                height: Number.NaN,
                trustedLocalMedia: true,
              },
              {
                type: "audio",
                path: "/tmp/empty.mp3",
                sizeBytes: 0,
                durationMs: 0,
                width: 0,
                height: 0,
              },
            ],
          },
        },
      }),
    ).toEqual({
      mediaUrls: ["/tmp/generated.mp3", "/tmp/empty.mp3"],
      attachments: [
        { path: "/tmp/generated.mp3" },
        { type: "audio", path: "/tmp/empty.mp3", sizeBytes: 0, durationMs: 0 },
      ],
    });
  });

  it("uses the image fallback path rather than media-looking text", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [
          { type: "text", text: "MEDIA:/tmp/unrelated.png" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
        details: { path: " /tmp/screenshot.png " },
      }),
    ).toEqual({ mediaUrls: ["/tmp/screenshot.png"] });
  });

  it("applies acceptMediaUrl to the legacy details.path fallback", () => {
    // The structured details.media path filters every candidate through acceptMediaUrl.
    // This legacy branch returned the raw path, so an untrusted tool's image reached
    // replay through the one route that skipped the caller's trust predicate.
    const result = {
      content: [
        { type: "text", text: "Read image file [image/png]" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
      details: { path: "/tmp/untrusted.png" },
    };
    const acceptMediaUrl = vi.fn(() => false);
    expect(extractToolResultMediaArtifact(result, { acceptMediaUrl })).toBeUndefined();
    expect(acceptMediaUrl).toHaveBeenCalledWith("/tmp/untrusted.png");
    // The same path still survives when the caller accepts it.
    expect(extractToolResultMediaArtifact(result, { acceptMediaUrl: () => true })).toEqual({
      mediaUrls: ["/tmp/untrusted.png"],
    });
  });

  it("ignores details.path and media-looking text without an image", () => {
    expect(
      extractToolResultMediaArtifact({
        content: [null, undefined, { type: "text", text: "MEDIA:/tmp/ok.png" }],
        details: { path: "/tmp/data.json" },
      }),
    ).toBeUndefined();
  });

  it("does not deliver empty structured media or image content without a fallback path", () => {
    expect(
      extractToolResultMediaArtifact({
        details: { media: {} },
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      }),
    ).toBeUndefined();
  });
});

describe("filterToolResultMediaUrls", () => {
  it("trusts core image generation without a run-local tool set", () => {
    expect(filterToolResultMediaUrls("image_generate", ["/tmp/image.png"])).toEqual([
      "/tmp/image.png",
    ]);
  });

  it("keeps only attested TTS local media when the raw built-in name is absent", () => {
    const result = markCoreTtsToolResult(
      { details: { media: { mediaUrl: "/tmp/reply.opus", trustedLocalMedia: true } } },
      ["/tmp/reply.opus"],
    );
    expect(
      filterToolResultMediaUrls(
        "tts",
        ["/tmp/reply.opus", "/tmp/unattested.opus", "https://example.com/audio.opus"],
        result,
        new Set(["web_search"]),
      ),
    ).toEqual(["/tmp/reply.opus", "https://example.com/audio.opus"]);
  });

  it("filters local media from unregistered plugin tools", () => {
    expect(
      filterToolResultMediaUrls("plugin_media_tool", [
        "/tmp/private.png",
        "https://example.com/image.png",
      ]),
    ).toEqual(["https://example.com/image.png"]);
  });

  it("keeps local media for exact plugin names trusted in this run", () => {
    expect(
      filterToolResultMediaUrls(
        "plugin_media_tool",
        ["/tmp/meeting.wav"],
        undefined,
        new Set(["plugin_media_tool"]),
      ),
    ).toEqual(["/tmp/meeting.wav"]);
  });

  it("does not let trustedLocalMedia bypass the exact-name gate", () => {
    expect(
      filterToolResultMediaUrls(
        "Web_Search",
        ["/etc/passwd", "https://example.com/file.png"],
        { details: { media: { mediaUrl: "/etc/passwd", trustedLocalMedia: true } } },
        new Set(["web_search"]),
      ),
    ).toEqual(["https://example.com/file.png"]);
  });

  it("does not trust external TTS results with trustedLocalMedia", () => {
    expect(
      filterToolResultMediaUrls("tts", ["/tmp/reply.opus", "https://example.com/audio.opus"], {
        details: {
          mcpServer: "probe",
          mcpTool: "tts",
          media: { mediaUrl: "/tmp/reply.opus", trustedLocalMedia: true },
        },
      }),
    ).toEqual(["https://example.com/audio.opus"]);
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let mediaAuthorityFixtureId = 0;

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-media-authority-");
  const sessionId = `session-${mediaAuthorityFixtureId++}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: Date.now() } });
  return { root, sessionManager: SessionManager.open(target, root), target };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("persisted local-media replay authority", () => {
  it("bounds and refreshes persisted media authority through channel context", async () => {
    const { root, sessionManager: sm, target } = await openPersistedSessionManager();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const collision = path.join(root, "media", "generated", "collision.png");
    const exact = path.join(root, "media", "generated", "exact.png");
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    fs.writeFileSync(collision, "collision");
    fs.writeFileSync(exact, "exact");
    let inspected = 0;
    const probeMediaUrls = Array(100_000).fill(exact);
    const iterateProbeMediaUrls = probeMediaUrls[Symbol.iterator].bind(probeMediaUrls);
    Object.defineProperty(probeMediaUrls, Symbol.iterator, {
      *value() {
        for (const mediaUrl of iterateProbeMediaUrls()) {
          inspected += 1;
          yield mediaUrl;
        }
      },
    });
    const boundedAuthorization = recordToolResultLocalMediaReplayAuthorization(
      { details: { media: { mediaUrls: probeMediaUrls } } },
      "exec",
      new Set(["exec"]),
    );
    expect(inspected).toBe(64);
    expect(
      asNullableRecord(asNullableRecord(boundedAuthorization.details)?.media)
        ?.localMediaReplayAuthorized,
    ).toBe(true);
    const guarded = guardSessionManager(sm, {
      runId: "run-allowed",
      trustedLocalMediaToolNames: new Set(["exec"]),
    });
    const appendToolResult = (
      manager: typeof guarded,
      id: string,
      name: string,
      mediaUrls: readonly string[],
    ) => {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls } },
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
    };
    try {
      guarded.appendMessage({
        role: "user",
        content: "inspect",
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);
      for (const [id, name, mediaUrls] of [
        ["colliding", "Bash", [collision]],
        ["exact", "exec", [exact]],
      ] as const) {
        appendToolResult(guarded, id, name, mediaUrls);
      }
      guarded.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `collision ${collision}; exact ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);

      const deniedRun = guardSessionManager(sm, {
        runId: "run-denied",
        trustedLocalMediaToolNames: new Set(),
      });
      deniedRun.appendMessage({
        role: "user",
        content: "recheck",
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);
      appendToolResult(deniedRun, "stale", "exec", [exact]);
      deniedRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `stale ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);

      const restoredRun = guardSessionManager(sm, {
        runId: "run-restored",
        trustedLocalMediaToolNames: new Set(["exec"]),
      });
      restoredRun.appendMessage({
        role: "user",
        content: "restore",
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);
      appendToolResult(restoredRun, "restored", "exec", [exact]);
      restoredRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `restored ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);

      const authorizations = sm.getEntries().flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "toolResult") {
          return [];
        }
        return [
          asNullableRecord(asNullableRecord(entry.message.details)?.media)
            ?.localMediaReplayAuthorized,
        ];
      });
      expect(deniedRun).toBe(guarded);
      expect(restoredRun).toBe(guarded);
      expect(authorizations).toEqual([false, true, false, true]);

      const ctx = {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionTranscriptContext: { historyLimit: 10 },
      } as FinalizedMsgContext;
      await mergeSessionTranscriptContext({
        agentId: target.agentId,
        ctx,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
        "inspect",
        `collision [unverified media reference removed]/generated/collision.png; exact ${exact}`,
        "recheck",
        `stale [unverified media reference removed]/generated/exact.png`,
        "restore",
        `restored ${exact}`,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("denies media authority until the run hands over its trust set", async () => {
    const { sessionManager: sm } = await openPersistedSessionManager();
    const appendExecResult = (manager: typeof sm, id: string) => {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls: [`/state/media/${id}.png`] } },
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
    };
    const guarded = guardSessionManager(sm, {
      runId: "run-first",
      trustedLocalMediaToolNames: new Set(),
    });
    appendExecResult(guarded, "before-handoff");
    guarded.setTrustedLocalMediaToolNames?.(new Set(["exec"]));
    appendExecResult(guarded, "after-handoff");
    // A same-run helper such as compaction reuses the manager without a set.
    expect(guardSessionManager(sm, { runId: "run-first" })).toBe(guarded);
    appendExecResult(guarded, "same-run-reuse");
    expect(
      guardSessionManager(sm, { runId: "run-second", trustedLocalMediaToolNames: new Set() }),
    ).toBe(guarded);
    appendExecResult(guarded, "next-run");

    const authorizations = sm.getEntries().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") {
        return [];
      }
      return [
        [
          entry.message.toolCallId,
          asNullableRecord(asNullableRecord(entry.message.details)?.media)
            ?.localMediaReplayAuthorized,
        ],
      ];
    });
    expect(authorizations).toEqual([
      ["before-handoff", false],
      ["after-handoff", true],
      ["same-run-reuse", true],
      ["next-run", false],
    ]);
  });

  it("grounds media-store URIs through channel context", async () => {
    const { root, sessionManager: sm, target } = await openPersistedSessionManager();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const inbound = path.join(root, "media", "inbound");
    fs.mkdirSync(inbound, { recursive: true });
    fs.writeFileSync(path.join(inbound, "granted.png"), "granted");
    fs.writeFileSync(path.join(inbound, "forged.png"), "forged");
    const guarded = guardSessionManager(sm, {
      runId: "run-media-uri",
      trustedLocalMediaToolNames: new Set(["exec"]),
    });
    try {
      for (const message of [
        { role: "user", content: "inspect", timestamp: Date.now() },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "granted", name: "exec", arguments: {} }],
          timestamp: Date.now(),
        },
        {
          role: "toolResult",
          toolCallId: "granted",
          toolName: "exec",
          content: [{ type: "text", text: "done" }],
          details: { media: { mediaUrls: ["media://inbound/granted.png"] } },
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "granted media://inbound/granted.png; forged media://inbound/forged.png; shouted MEDIA://inbound/forged.png",
            },
          ],
          timestamp: Date.now(),
        },
      ]) {
        guarded.appendMessage(message as Parameters<typeof guarded.appendMessage>[0]);
      }
      const ctx = {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionTranscriptContext: { historyLimit: 10 },
      } as FinalizedMsgContext;
      await mergeSessionTranscriptContext({
        agentId: target.agentId,
        ctx,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
        "inspect",
        "granted media://inbound/granted.png; forged [unverified media reference removed]/forged.png; shouted [unverified media reference removed]/forged.png",
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });
});
