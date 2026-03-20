import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_JSON_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    // Read the raw buffer first, then check its byte length before parsing.
    // A separate stat() + readFile() pair is vulnerable to TOCTOU: an attacker
    // could replace the file with a much larger one between the two calls,
    // bypassing the size guard entirely (Aisle Low: CWE-367 TOCTOU).
    // Reading into a Buffer first bounds the allocation check to the actual bytes read.
    const buf = await fs.readFile(filePath).catch(() => null);
    if (!buf) {
      return null;
    }
    if (buf.byteLength > MAX_JSON_FILE_SIZE_BYTES) {
      return null;
    }
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await fs.rename(tmp, filePath);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
      // best-effort; some platforms/filesystems do not support syncing directories.
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
