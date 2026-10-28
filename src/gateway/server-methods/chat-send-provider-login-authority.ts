// Split out of chat-send-agent-dispatch.ts, which sits at the line cap.
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Provider login needs a live operator.admin connection for every attempt the run makes. */
export function createProviderLoginAuthorityAssertion(
  client: GatewayRequestHandlerOptions["client"],
): () => void {
  return () => {
    client?.connectionSignal?.throwIfAborted();
    if (client?.invalidated || !client?.connect.scopes?.includes("operator.admin")) {
      throw new Error("Provider login authority is no longer active.");
    }
  };
}
