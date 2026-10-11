// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
import { beforeEach } from "vitest";
import { resetMessageToolSendSuppressionForTest } from "../src/agents/tools/message-tool-execution.send-suppression.js";
import { ensureSqliteLibrarySelected } from "../src/infra/bun-sqlite-library.js";
import { installSharedTestSetup } from "./setup.shared.js";

if (process.versions.bun) {
  ensureSqliteLibrarySelected();
}
installSharedTestSetup();
// FORK ADDITION, as in test/setup.extensions.ts: the fork's duplicate-send guard keeps
// process-global state keyed by runId, so a suite reusing one runId across cases would
// suppress later cases' sends (upstream's message-tool-execution.test.ts does).
beforeEach(() => {
  resetMessageToolSendSuppressionForTest();
});
// Select the host binding before platform fixtures can poison the dependency's process cache.
await sha256File(fileURLToPath(import.meta.url));
