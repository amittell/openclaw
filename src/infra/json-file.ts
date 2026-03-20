import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Atomic write: write to a temp file in the same directory then rename.
  // This prevents symlink/TOCTOU attacks where a symlink at `pathname` could
  // redirect the write to an arbitrary path — rename(2) replaces the target
  // atomically and does not follow symlinks at the destination.
  //
  // Use a cryptographically random suffix to prevent an attacker from
  // pre-creating the temp path as a symlink targeting an arbitrary file
  // (Aisle Low: CWE-377 — predictable temp filename enables symlink race).
  // The `flag: "wx"` (O_EXCL) ensures writeFileSync fails if the path already
  // exists (including as a symlink), preventing clobber via pre-created symlink.
  const randomSuffix = randomBytes(8).toString("hex");
  const tmpPath = path.join(dir, `.tmp-${randomSuffix}-${path.basename(pathname)}`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx", // O_EXCL: fail if path already exists (including symlinks)
    });
    fs.renameSync(tmpPath, pathname);
  } catch (err) {
    // Clean up temp file on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
