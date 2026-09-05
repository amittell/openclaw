import { rethrowExpectedCliError } from "../cli/failure-output.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

type SessionsAbortCliOptions = {
  key: string;
  runId?: string;
  clearQueued?: boolean;
  agent?: string;
  timeout?: string;
  url?: string;
  token?: string;
  password?: string;
  json?: boolean;
};

type SessionsAbortResult = {
  ok?: boolean;
  abortedRunId?: string | null;
  status?: "aborted" | "no-active-run";
};

type SessionsAbortRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

/**
 * `no-active-run` is a real outcome, not a failure: the operator asked for the
 * session to stop and it is already stopped. Reporting it as an error would
 * train callers to ignore the exit code. It still gets its own line, because an
 * operator who ran this against a session that *looks* stuck needs to know the
 * gateway found nothing to abort rather than assume the stop worked.
 */
function describeAbort(result: SessionsAbortResult, fallbackKey: string): string {
  if (result.status === "aborted") {
    const runId = result.abortedRunId;
    return runId
      ? `Aborted run ${runId} for session ${fallbackKey}.`
      : `Aborted active work for session ${fallbackKey}.`;
  }
  return `No active run for session ${fallbackKey}; nothing to abort. If the session still refuses new messages, its stored state is stale rather than busy - check \`openclaw sessions list\` and \`openclaw doctor\`.`;
}

/** Run `openclaw sessions abort <key>` against the running gateway. */
export async function sessionsAbortCommand(
  opts: SessionsAbortCliOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const agent = opts.agent?.trim();
  if (opts.agent !== undefined && !agent) {
    throw new Error("--agent must not be blank");
  }
  const runId = opts.runId?.trim();
  if (opts.runId !== undefined && !runId) {
    throw new Error("--run-id must not be blank");
  }
  const rpcOpts: SessionsAbortRpcOpts = {
    url: opts.url,
    token: opts.token,
    password: opts.password,
    // Unlike `sessions compact`, which passes null to opt out of a client
    // deadline because summarization can run for minutes, an abort is a fast
    // control operation. Leaving this undefined keeps the ordinary default so a
    // wedged gateway surfaces as a timeout instead of hanging the operator.
    timeout: opts.timeout,
    json: opts.json,
  };
  // clearQueued is rejected by the gateway alongside runId: scoping to one run
  // and discarding the whole session's queues are different intents.
  const params = {
    key: opts.key,
    ...(runId ? { runId } : {}),
    ...(agent ? { agentId: agent } : {}),
    ...(opts.clearQueued === true ? { clearQueued: true } : {}),
  };

  let result: SessionsAbortResult;
  try {
    result = (await callGatewayFromCliWithTransport("sessions.abort", rpcOpts, params, {
      defaultTimeoutMs: 10_000,
    })) as SessionsAbortResult;
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (opts.json) {
      writeRuntimeJson(runtime, { ok: false, key: opts.key, error: message });
    } else {
      runtime.error(`Abort failed: ${message}`);
    }
    runtime.exit(1);
    return;
  }

  // Success is explicit. A malformed or version-skewed payload must not read as
  // a successful no-op abort.
  if (result?.ok !== true) {
    if (opts.json) {
      writeRuntimeJson(runtime, result ?? { ok: false, key: opts.key });
    } else {
      runtime.error(`Abort failed for session ${opts.key}.`);
    }
    runtime.exit(1);
    return;
  }

  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(describeAbort(result, opts.key));
}
