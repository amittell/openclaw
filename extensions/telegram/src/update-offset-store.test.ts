import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { useTelegramKeyedState } from "./keyed-state.test-support.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";
import {
  deleteTelegramUpdateOffset,
  prepareTelegramAccount,
  readTelegramUpdateOffset,
  writeTelegramUpdateOffset,
} from "./update-offset-store.js";

describe("deleteTelegramUpdateOffset", () => {
  const fixture = useTelegramKeyedState<unknown>({
    namespace: "telegram.update-offsets",
    maxEntries: 1_000,
  });
  const writeOffset = (updateId: number, botToken?: string) =>
    writeTelegramUpdateOffset({ accountId: "default", updateId, botToken });
  const readOffset = (botToken?: string) => readTelegramUpdateOffset({ botToken });
  const prepare = (accountId = "default") =>
    prepareTelegramAccount({ accountId, botToken: "222222:fixture", onRotationDetected() {} });
  const state = (lastUpdateId: unknown, botId: string | null) => ({
    version: 3,
    lastUpdateId,
    botId,
    tokenFingerprint: null,
  });
  function failStore(method: "register" | "lookup", message: string) {
    fixture.install({
      ...fixture.open(),
      async [method]() {
        throw new Error(message);
      },
    });
  }

  it("only removes the targeted account offset, leaving others intact", async () => {
    await writeOffset(100);
    await writeTelegramUpdateOffset({ accountId: "alerts", updateId: 200 });

    await deleteTelegramUpdateOffset({ accountId: "default" });

    expect(await readOffset()).toBeNull();
    expect(await readTelegramUpdateOffset({ accountId: "alerts" })).toBe(200);
  });

  it("surfaces plugin-state write failures", async () => {
    failStore("register", "store write failed");
    await expect(writeOffset(808)).rejects.toThrow("store write failed");
  });

  // Offsets written here carry the default cloud root; v3 states predate root tracking (null).
  const cloudRoot = "https://api.telegram.org";
  it.each([
    ["bot-id-changed", "111111:token-a", "222222:token-b", 1500, "111111", "222222", cloudRoot],
    ["legacy-state", state(777, null), "333333:token-c", 777, null, "333333", null],
    ["legacy-state", state(999, "111111"), "111111:any-secret", 999, "111111", "111111", null],
    [
      "token-rotated",
      "111111:original-secret",
      "111111:rotated-secret",
      42,
      "111111",
      "111111",
      cloudRoot,
    ],
  ] as const)(
    "detects %s from %j",
    async (reason, previous, token, id, previousBotId, currentBotId, previousApiRoot) => {
      if (typeof previous === "string") {
        await writeOffset(id, previous);
        expect(await readOffset(previous)).toBe(id);
      } else {
        await fixture.store.register("default", previous);
      }
      const onRotationDetected = vi.fn();
      expect(await readTelegramUpdateOffset({ botToken: token, onRotationDetected })).toBeNull();
      expect(onRotationDetected.mock.calls).toEqual([
        [
          {
            reason,
            previousBotId,
            currentBotId,
            staleLastUpdateId: id,
            previousApiRoot,
            currentApiRoot: null,
          },
        ],
      ]);
    },
  );

  it("rotates when the Bot API root changes, because update ids are server-scoped", async () => {
    const token = "111111:same-secret";
    await writeOffset(760_546_622, token);

    expect(
      await readTelegramUpdateOffset({ botToken: token, apiRoot: "https://api.telegram.org/" }),
    ).toBe(760_546_622);

    const onRotationDetected = vi.fn();
    expect(
      await readTelegramUpdateOffset({
        botToken: token,
        apiRoot: "http://localhost:8081",
        onRotationDetected,
      }),
    ).toBeNull();
    expect(onRotationDetected.mock.calls).toEqual([
      [
        {
          reason: "api-root-changed",
          previousBotId: "111111",
          currentBotId: "111111",
          staleLastUpdateId: 760_546_622,
          previousApiRoot: "https://api.telegram.org",
          currentApiRoot: "http://localhost:8081",
        },
      ],
    ]);

    await writeTelegramUpdateOffset({
      accountId: "default",
      updateId: 592_426_393,
      botToken: token,
      apiRoot: "http://localhost:8081/",
    });
    expect(
      await readTelegramUpdateOffset({ botToken: token, apiRoot: "http://localhost:8081" }),
    ).toBe(592_426_393);
  });

  it("treats offsets persisted before root tracking as cloud offsets", async () => {
    const token = "111111:same-secret";
    await fixture.store.register("default", {
      ...state(760_546_622, "111111"),
      tokenFingerprint: fingerprintTelegramBotToken(token),
    });

    expect(
      await readTelegramUpdateOffset({ botToken: token, apiRoot: "https://api.telegram.org" }),
    ).toBe(760_546_622);

    const onRotationDetected = vi.fn();
    expect(
      await readTelegramUpdateOffset({
        botToken: token,
        apiRoot: "http://localhost:8081",
        onRotationDetected,
      }),
    ).toBeNull();
    expect(onRotationDetected.mock.calls).toEqual([
      [
        expect.objectContaining({
          reason: "api-root-changed",
          previousApiRoot: null,
          currentApiRoot: "http://localhost:8081",
        }),
      ],
    ]);
  });

  it("tolerates read-only lookup failures but refuses account preparation without identity", async () => {
    failStore("lookup", "store unavailable");
    expect(await readTelegramUpdateOffset({ accountId: "primary" })).toBeNull();
    await expect(prepare("primary")).rejects.toThrow(
      /account "primary".*restart.*store unavailable/,
    );
  });

  it("awaits rotation cleanup before returning", async () => {
    await writeOffset(42, "111111:original");

    let cleaned = false;
    const offset = await readTelegramUpdateOffset({
      accountId: "default",
      botToken: "111111:rotated",
      onRotationDetected: async () => {
        await setImmediate();
        cleaned = true;
      },
    });

    expect(offset).toBeNull();
    expect(cleaned).toBe(true);
  });

  it.each([-1, "not-a-number"])("ignores invalid persisted update ID %j", async (id) => {
    await fixture.store.register("default", state(id, "111111"));
    expect(await readOffset()).toBeNull();
  });

  it.each([1, 2])("requires Doctor before reading or preparing a v%s offset", async (version) => {
    const original = {
      version,
      lastUpdateId: 777,
      ...(version === 2 ? { botId: "111111" } : {}),
    };
    await fixture.store.register("default", original);
    await expect(readOffset()).rejects.toThrow("openclaw doctor --fix");
    await expect(prepare()).rejects.toThrow("openclaw doctor --fix");
    expect(await fixture.store.lookup("default")).toEqual(original);
  });

  it("rejects writing invalid update IDs", async () => {
    await expect(writeOffset(-1)).rejects.toThrow(/non-negative safe integer/i);
  });
});
