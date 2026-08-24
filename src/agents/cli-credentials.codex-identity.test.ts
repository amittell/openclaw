/** Codex auth.json and Keychain identity parsing against Codex token_data. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexAuth, resetCliAuthCaches } from "./cli-auth.test-support.js";

const tempDirs: string[] = [];

function createJwt(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

function createCodexAuth(emailClaims: Record<string, unknown>) {
  return {
    tokens: {
      id_token: createJwt(emailClaims),
      access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3_600 }),
      refresh_token: "synthetic-refresh",
      account_id: "acct-codex",
    },
    last_refresh: new Date().toISOString(),
  };
}

afterEach(() => {
  resetCliAuthCaches();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Codex CLI credential identity", () => {
  it("lifts top-level ID-token email from auth.json", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-identity-file-"));
    tempDirs.push(codexHome);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(createCodexAuth({ email: "file@example.com" })),
      { encoding: "utf8", mode: 0o600 },
    );

    expect(
      readCodexAuth({ codexHome, platform: "linux", allowKeychainPrompt: false }),
    ).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct-codex",
      email: "file@example.com",
    });
  });

  it("lifts nested profile email from Codex Keychain token_data", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-identity-keychain-"));
    tempDirs.push(codexHome);
    const execSync = vi.fn(() =>
      JSON.stringify(
        createCodexAuth({
          "https://api.openai.com/profile": { email: "keychain@example.com" },
        }),
      ),
    );

    expect(readCodexAuth({ codexHome, platform: "darwin", execSync })).toMatchObject({
      type: "oauth",
      provider: "openai",
      accountId: "acct-codex",
      email: "keychain@example.com",
    });
    expect(execSync).toHaveBeenCalledOnce();
  });
});
