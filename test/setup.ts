// Default test setup installs the shared test environment.
import { fileURLToPath } from "node:url";
import { sha256File } from "@openclaw/fs-safe/durability";
<<<<<<< 5a94eab2146e558b3ebcd41cb174fc5adc469c2a
import { isSupported as isProcessIdentitySupported } from "@openclaw/proc-safe/identity";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();
// Select host bindings before platform fixtures can poison the dependencies' process caches.
=======
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
// Select the host binding before platform fixtures can poison the dependency's process cache.
>>>>>>> eb8762e11097ab2b75dbb0e571348998a9d2ea31
await sha256File(fileURLToPath(import.meta.url));
isProcessIdentitySupported();
