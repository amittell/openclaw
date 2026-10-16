import { homedir } from "node:os";
import {
  appendConfigAuditRecord,
  type ConfigExternalChangeAuditRecord,
} from "../config/io.audit.js";

/** Journals a config change the reloader observed at its watch path rather than wrote. */
export async function appendConfigExternalChangeAudit(
  configPath: string,
  record: Omit<ConfigExternalChangeAuditRecord, "ts" | "source" | "event" | "configPath">,
): Promise<void> {
  await appendConfigAuditRecord({
    env: process.env,
    homedir,
    record: {
      ts: new Date().toISOString(),
      source: "config-io",
      event: "config.external",
      configPath,
      ...record,
    },
  });
}
