// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
import { isSupported as isProcessIdentitySupported } from "@openclaw/proc-safe/identity";
import { beforeEach } from "vitest";
import { resetMessageToolSendSuppressionForTest } from "../src/agents/tools/message-tool-execution.send-suppression.js";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();
// FORK ADDITION, as in test/setup.extensions.ts: the fork's duplicate-send guard keeps
// process-global state keyed by runId, so a suite reusing one runId across cases would
// suppress later cases' sends (upstream's message-tool-execution.test.ts does).
beforeEach(() => {
  resetMessageToolSendSuppressionForTest();
});
// Select host bindings before platform fixtures can poison the dependencies' process caches.
await sha256File(fileURLToPath(import.meta.url));
isProcessIdentitySupported();
