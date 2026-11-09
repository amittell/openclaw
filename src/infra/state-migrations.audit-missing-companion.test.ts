// Fork carry of upstream #186998 onto v2026.10.10-beta.4: a raw config-audit archive whose
// checkpoint no longer matches its file identity (mac-mini's st_dev moved after a remount) is
// re-detected, and with its sanitized companion gone and every record already imported, Doctor
// skips the recovery with a warning instead of refusing every later repair.
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  configAuditRecord,
  withAuditMigrationFixture,
} from "./state-migrations.audit.test-support.js";

describe("legacy config audit recovery without its sanitized companion", () => {
  it("skips with a warning when every raw record is already imported", async () => {
    await withAuditMigrationFixture(async (audit) => {
      await audit.writeJsonLines(audit.config.source, [configAuditRecord("first")]);
      expect((await audit.migrate()).warnings).toEqual([]);
      expect(audit.detect().sources).toEqual([]);

      // Same bytes and mtime under a new inode: the checkpoint's file identity no longer matches.
      const raw = await fs.readFile(audit.config.raw);
      const { mtime, atime } = await fs.stat(audit.config.raw);
      await fs.rm(audit.config.raw);
      await fs.writeFile(audit.config.raw, raw);
      await fs.utimes(audit.config.raw, atime, mtime);
      await fs.rm(audit.config.sanitized, { force: true });

      const detected = audit.detect();
      expect(detected.sources).toMatchObject([
        { sourcePath: audit.config.raw, storage: "raw-archive" },
      ]);
      const result = await audit.migrate(detected);
      expect(result.warnings.join("\n")).toContain(
        "sanitized companion is missing and no records remain to import",
      );
      expect(result.warnings.join("\n")).not.toContain("Refused");
      expect(await fs.readFile(audit.config.raw)).toEqual(raw);
      expect(audit.configRecords()).toHaveLength(1);
    });
  });
});
