# Porting ledger — `upgrade-v2026.8.1`

Fork: `amittell/openclaw`. Upstream: `openclaw/openclaw`.
Base: tag **`v2026.8.1`** = `ea806575e64`.

This is the successor to the `upgrade-v8.1-beta.3` ledger. It records how the
fork's work was carried onto the production tag, what was **not** carried and
why, and which claims are measured versus assumed. Read the "Not established"
section before relying on anything here.

## The base is not on `main`, and that shapes everything

    merge-base(v2026.8.1, upstream/main)   0a6c013be5f5
    commits on the tag, not on main         19
    commits on main, not on the tag        472
    refs containing the tag                upstream/release/2026.8.1

`v2026.8.1` sits on a **release branch**, not on `main`. So "upstream has this
now" is two different claims — present on `main` and present at the tag — and
only the second one matters for this branch. Several carry decisions turned on
exactly that distinction, and at least one lane's brief was wrong because a
symbol existed on `main` but not at the tag.

## Method

Fork ports are **semantic re-anchors, not textual merges**. Upstream moved,
renamed, extracted and deleted the code the fork had patched, so:

- `git cherry` and patch-id are useless here — they report "unapplied" for work
  upstream absorbed under a different shape, and "applied" for nothing.
- Carry detection was done by **identifier**: does the fork's symbol exist at
  the tag, and does it mean the same thing? Every absence claim was run with a
  **positive control** (a symbol known to be present) so that a broken search
  could not read as a clean zero.
- Each fork delta was diffed against **its own base** (beta.2 ← `7160c4de0bf`,
  beta.3 ← `8578b8f55cf`), then 3-way merged onto the tag with
  `git merge-file -p tag base fork`. Absorption was measured as
  _merged result == tag_, never inferred from a conflict verdict.

**A conflict verdict is not evidence of non-absorption.** At least one file
reported CONFLICT and was byte-identical to the tag — a purely positional
collision. Every conflict was re-checked against content.

## Carry lanes

| lane                                  | scope                 | outcome |
| ------------------------------------- | --------------------- | ------- |
| ui / packages / scripts / docs        | merged                | landed  |
| gateway + `src/config/sessions`       | merged                | landed  |
| `/temperature` directive              | rescued from mac-mini | landed  |
| commands / infra / plugins / channels | merged                | landed  |
| `src/agents`                          | 53 files              | landed  |
| `extensions`                          | 21 files              | landed  |

## Corrections found during the carry

These were briefs that measurement refuted. Recorded because each would have
shipped a defect or lost real work.

- **`state-migrations.doctor.ts` — take beta.2, not beta.3.** The
  `hasExplicitSessionStoreOwner` disjunct exists only on beta.2; taking beta.3
  would have shipped the live defect the fork already fixed.
- **`isSystemChannelTurn` was a trap in the dangerous direction.** Upstream
  deleted it and `normalizeInternalTurnContext` now _deletes_ `Provider` for
  those values, so carrying the fork's predicate verbatim yields a silently
  always-false opt-out that double-sends on system turns. Re-expressed as
  `InternalTurnSource === undefined`.
- **`telegram/src/bot-core.ts` is NOT absorbed.** Its delta is a one-line
  `completed: true -> false` on the retryable-error path. Dropping it would have
  silently lost a durable-retry fix.
- **`memory-lancedb` anchors closer to beta.3, not beta.2.** beta.3's base
  already carries upstream's `auto-recall.ts` extraction and the
  `numDeletedRows` delete, so beta.3's mocks are already correct where beta.2's
  are broken. Taking beta.3 merged clean where beta.2 conflicted six times.
- **`embed()` changed arity at the tag** — it now requires a third
  `embedding: EmbeddingConfig`. beta.2's two-argument call sites would not have
  compiled.
- **`subagent-spawn-gateway.ts` is a strict superset upstream**, adding a third
  `getPluginRuntimeGatewayRequestScope()` fallback the fork lacks. Absorbed.

## Deliberate losses

Recorded so they do not disappear into a merge. Nothing fails without these.

- **`sessions-list-tool.ts` "paused" status.** Upstream replaced the check with
  `Value.Check(SessionRunStatusSchema, …)` and the schema has no `"paused"`, so
  carrying it is a type error. beta.3 dropped it too. Restoring it needs a
  protocol-schema change, which is a separate decision.
- **`external-cli-sync.email-backfill.test.ts`.** Upstream deleted the file in
  `750a64e7cd4`; its mocked symbol `readClaudeCliCredentialsCached` has moved to
  `src/plugin-sdk/` and the guarded path no longer exists.
- **`compaction-safeguard.test.ts` fork edits.** All five conflicts are
  mis-anchored: both fork-modified tests were deleted in upstream's restructure,
  so each conflict pairs the fork's edit against an unrelated upstream test.
  Taking either side destroys upstream tests, so the file was left byte-identical
  to the tag. **The behaviour itself is now covered fresh** — see below.
- **Telegram pair-loop wiring** (`bot-handlers.bot-pair-loop.{ts,test.ts}`).
  Both are the empty blob `e69de29bb2d1`, and `inbound-pipeline.ts`'s entire
  delta wires to that missing module — carrying it reproduces beta.2's
  non-building tip. Deferred as a unit. The guard core _is_ upstream at
  `src/plugin-sdk/pair-loop-guard-runtime.ts`, so the wiring is viable but is
  genuinely new code. `clickclack/src/accounts.ts` is the assertion-free
  precedent to copy.

## Fresh coverage: the compaction-safeguard degrade path

The fork narrows exactly one branch of the quality guard. At the terminal
branch (`!canRegenerate || attempt >= totalAttempts - 1`), when the last
permitted attempt still fails `auditSummaryQuality`:

|        | upstream `ea806575e64`                                               | fork                                                                           |
| ------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| action | `setCompactionSafeguardCancellation(...)`, `return { cancel: true }` | `finalizeSummaryText(buildStructuredFallbackSummary(...))`, return the summary |

Every adjacent unrecoverable path (LLM throw, corrective-generation failure,
`qualityRetentionInfeasible`, no model/API key) **still cancels** — the fork
did not broaden the degrade.

It shipped with **no coverage**, and none existed upstream either (verified
against the tag's tree, not just the working tree: the upstream cancellation
log line has exactly one hit, in the source file). Coverage now lives in
`src/agents/agent-hooks/compaction-safeguard.degrade-fallback.test.ts`
(273 lines, 6 tests), deliberately a **sibling** rather than an extension of
`compaction-safeguard.test.ts` — that file is 5,129 lines behind an
`oxlint-disable max-lines` suppression, so a test added there would hide behind
an existing suppression instead of passing a real gate, and it is the same file
whose conflicts mis-anchor at every tag.

Mutation oracle, run twice, start-to-finish in one invocation with a restore trap:

    fork code           EXIT=0   6 passed
    tag block restored  EXIT=1   4 failed | 2 passed
    fork code restored  EXIT=0   6 passed, byte-identical to backup

The 2 that stay green are predicted controls — one is structural (same call
counts either way), one runs with the guard disabled and never reaches the
branch. A mutation reddening _everything_ would have meant a broken harness,
not a good test.

## Gate state

- **Assertion-safety ratchet: passing.** 4147 files / 12786 grandfathered.
  ~122 inherited sites were annotated across the carry lanes; the baseline was
  then pruned. The prune was verified **shrink-only** — 4169 → 4147 entries,
  zero counts grew, zero rows added.
- **max-lines ratchet: passing** (881 grandfathered suppressions).
- **Env-var count budget: raised 500 → 501**, owner-approved, for
  `OPENCLAW_GATEWAY_POST_SHUTDOWN_EXIT_TIMEOUT_MS` in `src/gateway/server-close.ts`
  — the fork's post-shutdown zombie-process guard. The carry added four
  `OPENCLAW_*` names but only this one counts: one is in a test file (the
  counter excludes tests) and two are in gitignored `packages/plugin-sdk/dist/`
  build output (the counter uses `git ls-files --exclude-standard`).
- **Direct `oxlint` over `src`: 5 errors, ALL pre-existing at the tag** (which
  itself reports 6). The carry introduces none.
- **A grep line-counter over-counts by ~10** against real oxlint (771 vs 761).
  Every budget claim here is from `npx oxlint`, never from grep.
- **`oxfmt` relocates a standalone `// SAFETY:` comment onto a ternary's `?`
  line**, silently un-annotating the assertion. Re-check the ratchet _after_
  formatting, not before.
- **`oxfmt` rewrites a prose `-` to an em-dash in markdown**, which makes
  patch anchors fail silently.
- **A mutation left applied by a timed-out command.** A `commit` chained after
  a mutate/restore sequence hit the tool's two-minute ceiling _between_ the two,
  leaving the neutralized file staged for commit. Do the mutate → run → restore
  inside one invocation, and re-verify the restore afterwards.
- **`$?` after a pipeline reports the last command, not the interesting one.**
  A `... | tail` made a failing gate read as `rc=0`.

## Over-budget files and how they were split

Seven files carried fork additions past `max-lines`. The baseline is shrink-only
and its header says "Split files", so each was split by **pure code motion**
into a cohesive sibling — no baseline rows, no `oxlint-disable`.

| file                                     | before | after   | sibling                                                |
| ---------------------------------------- | ------ | ------- | ------------------------------------------------------ |
| `directive-handling.impl.ts`             | 717    | **613** | `ack-parts.ts` 158                                     |
| `auth-controller.ts`                     | 718    | **678** | `cooldown-probe.ts` 48                                 |
| `auth-controller.test.ts`                | 1077   | **728** | `refresh-deadline.test.ts` 272 + `test-support.ts` 122 |
| `run-loop.ts`                            | 728    | **689** | `run-loop.exhaustion.ts` 106                           |
| `terminal-resolution.ts`                 | 718    | **640** | `settled-turn.ts` 93                                   |
| `message-tool-execution.ts`              | 741    | **696** | `send-suppression.ts` 57                               |
| `heartbeat-runner.tool-response.test.ts` | 1004   | **997** | `previews.test.ts` 8                                   |

Every number is from real oxlint. Test totals were identical across each split
(252, 25, 47, 240, 40). Where a moved symbol had external importers it is
re-exported from the original, so no importer path changed.

**Two files have thin headroom** — `message-tool-execution.ts` at 696/700 and
`heartbeat-runner.tool-response.test.ts` at 997/1000. Any further addition
re-breaks them. The next clean seam on the first is the file-local
`type MessageToolOptions` (39 effective lines, no external importers).

**One split has a real side effect**: `heartbeat-runner.tool-response.previews.test.ts`
is auto-classified as a _unit-fast_ test by the repo's own content-based
`getUnitFastTestFilesForIncludePatterns`, so `vitest.infra.config.ts` now
excludes it and it runs under `vitest.unit-fast.config.ts`. Running the infra
config no longer covers that test.

## The formatter and the assertion ratchet can disagree

Two `memory-lancedb` SAFETY comments sat above an assertion inside a ternary.
`oxfmt` rewrites that onto the `?` line:

    // SAFETY: ...                    ->    ? // SAFETY: ...
    ? (cfg.dreaming as Record<...>)         (cfg.dreaming as Record<...>)

which the ratchet no longer detects — `config.ts: 1 > 0`. So the two gates could
not both pass. **A trailing comment on the `as` line survives both** and is the
form to use inside a ternary.

## The build needs a dependency sync, and the failure blames the wrong thing

A first `npm run build` on this branch failed with:

    [MISSING_EXPORT] "TuiMainScreen" is not exported by
      "node_modules/@earendil-works/pi-tui/dist/index.js"
      ╭─[ src/tui/tui.ts:10:3 ]

That reads as a carry defect in `src/tui`, and it is not one:

    the TAG itself imports TuiMainScreen        tui.ts:10, used at :932
    the carry's diff for that file              empty
    package.json wants @earendil-works/pi-tui   0.84.2
    installed                                   0.82.1

**Stale `node_modules`.** `pnpm install --frozen-lockfile` brings it to 0.84.2,
which exports the symbol. Sync dependencies before reading any build failure on
this branch — the tag moved several package versions and an out-of-date tree
reports the mismatch as a missing export in _our_ source.

**This applies to the hosts too, and it changes the deploy procedure.** Measured
on both:

    rh-bot.lan      @earendil-works/pi-tui  0.82.1
    mac-mini.lan    @earendil-works/pi-tui  0.82.1
    this branch needs                       0.84.2

The usual deploy is `git fetch && git checkout <sha> && pnpm build && restart`.
On this branch that **fails on both hosts**, with the same misleading
MISSING_EXPORT pointing at `src/tui/tui.ts`. The deploy must run
`pnpm install` between the checkout and the build.

Note also that the build's exit code is not what a wrapping harness may report.
The first run's harness line said `exit code 0` while the real status was **1**;
the failure was only visible because the log carried an explicit
`BUILD_RC=$?`. Capture the status yourself rather than reading a runner's
summary line.

## Deploying 8.1 needs THREE prerequisites, and they only surface at runtime

Measured the hard way on rh-bot, which I took down for ~35 minutes doing it.
A clean build proves the code compiles. It says nothing about whether the
gateway can START. All three of these failed after a green build:

1. **pnpm major upgrade.** beta.3 pinned `pnpm@11.15.1`; the tag pins
   `pnpm@12.1.0`. Hosts cannot self-provision it — pnpm v12 ships a native
   binary that replaces a placeholder in `~/Library/pnpm/.tools/pnpm/12.1.0/bin`,
   and on an older pnpm that replacement never happens (`ENOEXEC`). Clearing the
   directory and retrying reproduces it exactly. Fix: `npm i -g pnpm@12.1.0`.
   rh-bot was on a non-brew pnpm (brew only offers 11.24.0); mac-mini is on
   10.30.1.

2. **Agent identity migration.** 8.1 adds a migration that requires stopped
   writers. The gateway refuses to start until it is done:

       OpenClaw startup migrations did not complete cleanly; refusing to report
       the gateway ready. ... Agent identity migration requires stopped-writer
       maintenance; stop active agents and run openclaw doctor --fix.

   Procedure: `launchctl bootout` the scheduler and inbox-watcher, run
   `doctor --fix` (rc=0), restart, then bootstrap them back. **Back up the agent
   sqlite DBs first** — 1.9G on rh-bot — because the migration may be one-way and
   a rollback to beta.3 would otherwise have nowhere to go.

3. **LanceDB native binding.** `pnpm install --frozen-lockfile` left
   `@lancedb/lancedb` installed WITHOUT `@lancedb/lancedb-darwin-arm64`, and the
   gateway fails with `Cannot find native binding`. `rm -rf node_modules` plus a
   fresh install fixes it. The binding is a proper optionalDependency of
   `@lancedb/lancedb@0.37.1` and is in the lockfile, so this is the known
   optional-dependency resolution problem, not a manifest defect.

**So the procedure is: upgrade pnpm -> checkout -> rm -rf node_modules ->
pnpm install -> pnpm build -> back up agent DBs -> stop writers ->
doctor --fix -> start gateway -> bootstrap writers.**

**And validate on a spare port BEFORE touching the live service.** Running
`dist/index.js gateway --port 18790` surfaces every one of these with zero
downtime; it is how each was finally diagnosed, and doing it first would have
avoided the outage entirely. Note it refuses to run if a gateway already owns
the state directory, which is itself a useful liveness check.

## Instrument failures during that deploy, each of which gave a confident wrong answer

- **`cmd | tail && echo RC=$?` reports `tail`'s status.** This produced
  `INSTALL_RC=0 BUILD_RC=0` on a host where neither had run — pi-tui was still
  0.82.1 and `dist` was four days old. Capture the status of the command itself.
- **Two PID samples of `-` compare equal.** A stability check that reads
  `launchctl list` twice and compares reported STABLE while the service was
  absent. Require both samples to be live PIDs before comparing them.
- **`launchctl list`'s status column is the LAST exit, not current health.** A
  healthy, serving gateway shows `last=1` from an earlier failed start forever.
  Read the PID and probe the port.
- **`rh-bot.lan` stopped resolving mid-deploy** while the host was fine — ssh to
  `192.168.210.168` worked throughout. A _control_ is what caught it: mac-mini
  was also unreachable at that moment, and I had not touched its services. But
  the control was itself a transient false negative — mac-mini answered on the
  next retry. Retry before concluding anything from a ping.
- **A path guess produced a clean zero.** `ls node_modules/@lancedb` read empty
  while an install was mid-flight, which looked like "the fix failed". It was a
  race. Check whether the writer is still running before reading its output.

## Coverage audit against beta.1 and beta.2, and what it found

The carry used beta.2 and beta.3 as sources. **beta.1 was never consulted.** An
audit compared fork-authored _added declarations_ (not test titles) from beta.1
and beta.2 against this branch, using the source branch as a positive control:

    beta.1   80 fork commits, 270 declarations   -> 2 candidate gaps
    beta.2  103 fork commits, 329 declarations   -> 17 raw gaps

Of the 17: **4 were false positives** (`buildSessionSummary` is only an import
alias; `sessionCache`/`sessionCacheKey`/`cappedTimeout` are upstream-era
`collector.ts` code the tag superseded -- the fork never modified that file),
**6 were already-documented deliberate decisions**, and 7 were real. With
beta.1's 2, nine items were investigated individually.

| item                                       | verdict     | basis                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auto-reply durable-fallback probe evidence | **CARRIED** | `agent-runner-auto-fallback.ts` blob is byte-identical tag<->HEAD and differs on beta.2 -- upstream never absorbed it                                                                                                                                                                                           |
| `zombieWarnCount` dedup-latch coverage     | **CARRIED** | added 16:50:41, deleted 16:53:44 inside an unresolved conflict block; collateral of a marker-clearing pass                                                                                                                                                                                                      |
| auto-recall embed timeout 15s -> 5s        | **CARRIED** | beta.3 _intended_ to carry it (`3e0d2d31d62`, "Lower auto-recall embed timeout 15s->5s") but the hunk failed silently because the code had moved to `auto-recall.ts`                                                                                                                                            |
| `buildMessageToolOnlyDelivery`             | **CARRIED** | beta.1's tip committed 12.9 min AFTER beta.2's final commit, so beta.2 could not have carried it                                                                                                                                                                                                                |
| `getShuttingDown`                          | DROP        | deliberate, argued in `1e9289f9635`; a test-only injection seam beta.3 replaced with tests that drive the real `markGatewayShuttingDown()`                                                                                                                                                                      |
| `sessionRunActive`                         | DROP        | deliberate, argued in `ddad4595279`; `paused` is not in 8.1's `SessionRunStatus` union, so the premise cannot occur                                                                                                                                                                                             |
| pending-final-delivery attempt cap         | DROP        | upstream absorbed it as a recovery state machine that tombstones with an operator notice. Carrying it would be HARMFUL: `projectCanonicalSessionEntryShape` strips `pendingFinalDeliveryAttemptCount` before persistence, so the cap would read 0 forever -- a safeguard that can never fire but looks like one |

**The structural lesson: beta.3's own ledger audited its drops using fork-added
TEST TITLES.** Two of the four carried items added no tests, so they were
invisible to that instrument by construction. An audit keyed on declarations
found them. Whatever key you choose, state it -- it defines what the audit
cannot see.

## The `oxlint` figures in this ledger were measured on a stale linter

Earlier revisions reported "5-6 pre-existing errors at the tag"
(`preserve-caught-error`, `no-control-regex`). That was **oxlint 1.75.0 from
stale `node_modules`**. The repo pins **1.79.0** at the tag and on this branch,
and under the pinned version `oxlint src extensions` is **clean, rc=0** --
controlled with a probe file that correctly reported 3 errors. Sync
dependencies before quoting any lint figure.

## Known red, pre-existing, not from the carries

`src/agents/embedded-agent-runner/run.prepared-harness-source-delivery.integration.test.ts`
fails **3 of 11** on a `modeTransitions` mismatch. Measured at clean HEAD with
the whole working tree stashed, so it predates the coverage-audit carries. Note
it lives in the `agents` project, NOT `agents-embedded-agent-run` -- pointing the
wrong config at it prints "No test files found" and exits 1, which reads exactly
like a test failure.

## Grep upstream's BASE before filing anything against it

A fork pinned to a TAG ages exactly like a frozen deployment: `main` keeps
moving, so with every day the odds rise that any defect you find is already
fixed upstream. Treat "this may already be fixed" as the DEFAULT for fork work.

    git fetch upstream
    git show upstream/main:<path> | grep -n '<the defective token>'
    git log --oneline -5 upstream/main -- <path>
    git rev-list --count <your-base>..upstream/main     # how stale you are

**Measured cost of skipping it, 2026-09-02.** The hardcoded `/tmp` store path in
`bot.create-telegram-bot.test.ts` was diagnosed, fixed, and proven
two-directionally with the real stale artifact planted -- then found to be
already fixed on `upstream/main`, **character-for-character the same line**. The
only reason it surfaced is that opening a PR requires naming a base branch.

**The trigger is a MOMENT, not a state: the moment you decide to file, before
writing any PR body.** "When in doubt" never fires, because a finished
investigation -- reproduction, fix, oracle -- feels certain, and that is exactly
when the question stops being asked.

Note this is a different axis from searching the issue tracker. The tracker
answers _has someone reported it_; the base answers _has someone already fixed
it_. A clean tracker says nothing about the code.

**And when it IS already fixed, the right action is the inverse of a PR: adopt
upstream's exact line.** Carrying their wording verbatim makes the next rebase a
no-op on that file; landing your own equivalent fix manufactures a divergence to
reconcile later. That is what commit `63123709fef` does.

## Not established

- **No full test-suite run.** Individual files were run; the suite as a whole
  has not been, and several lanes reported that their carried files had never
  been executed at all.
- **The branch BUILDS** — `npm run build` rc=0 in 5m11s, after the dependency
  sync above. No typecheck beyond tsgo:core.
- **SAFETY invariants on inherited assertions are readings, not proofs.** The
  ratchet counts comments; it never validates the claim. They assert properties
  of code the annotator did not author.
- **The `fallbackBaseUrl` embedding failover is the highest-risk carry.** It
  merged cleanly with correct symbols, but its timeout-splitting and cooldown
  semantics are untested here. `embeddings.failover.test.ts` is the instrument.
- **`compaction-safeguard.ts` heartbeat/`isHeartbeatPrompt` re-anchor.** One
  proposed re-anchor was proven _wrong_ and reverted; the correct one was not
  established, so beta.3's heartbeat test remains unsatisfied.
- **Deployment.** Nothing from this branch has been deployed. The two hosts are
  NOT on the same thing, which an earlier reading of this ledger got wrong:

      rh-bot.lan      77549fa3889   beta.3
      mac-mini.lan    8f120b77a7f   the WIP /temperature rescue commit

  Neither is an ancestor of this branch, so both are switches, not fast-forwards.

  **rh-bot is now DEPLOYED** on `2801f5f4337` (build id
  `2026.8.1-2801f5f43371-2026-09-01T00-25-36.127Z`), serving HTTP 200, stable
  PID across 45s, scheduler and inbox-watcher bootstrapped back. mac-mini is
  untouched. Its agent-DB backup is at
  `~/.openclaw/agent-db-backup-20260831-203148` (1.9G) and beta.3
  (`77549fa3889`) is still present in its object store, so rollback remains
  available.

  **Superseded 2026-09-01 evening (measured 2026-09-02 20:14 EDT):** both hosts
  are on `2644b2b5d00` (`git -C ~/.openclaw/openclaw log -1`, detached HEAD),
  dist built 20:45 (rh-bot) and 20:50 (mac-mini) on 2026-09-01. Neither is on
  the branch head. The four commits since (`52c01cf1023`..`bae9961f430`) plus
  the fixes below are the pending deploy.

  **DEPLOYED 2026-09-02 22:22 (rh-bot) and 22:35 (mac-mini): both hosts on
  `2be4112e856`** (`git -C ~/.openclaw/openclaw log -1`), each via stop ->
  checkout -> `pnpm build` (3m02s on the M4) -> smoke on port 18790 (healthz
  200, `[gateway] ready`) -> launchd bootstrap -> healthz 200. No dependency
  change since `2644b2b5d00`, so no install and no doctor run. Both gateways
  run `/opt/homebrew/opt/node/bin/node` (26.x), the binary macOS has granted
  Local Network access. On mac-mini the smoke run itself performed the
  `api-root-changed` rotation of the two pre-root offset rows.

## Next port item: the compaction-safeguard workstream

Alex, 2026-09-02 22:30: land the fork's compaction-safeguard set (#721-#723,
`amittell/openclaw#5`, base beta.2, "137/137 tests pass, mergeStateStatus
DIRTY") as the next carry onto this branch. Evidence for why: rh-bot's group
session `agent:main:telegram:group:-5268075089` reached 3,595 events / 16 MB /
~656 K estimated tokens with exactly one compaction since 2026-08-25, every
turn routing `compact_only`, about an hour per turn. The session was reset the
same night (transcript preserved in SQLite) so the bot answers; the defect
that let it grow is the workstream.

## 2026-09-02: both bots silent, two unrelated causes, both outside this branch

Measured on the hosts, not inferred from this ledger. Each had a different
root cause, and neither was the port.

**mac-mini: a Telegram polling hot loop, 4.9 M polls in 3 h.** At 17:43:58 a
config reload switched `channels.telegram.apiRoot` to a local Bot API server
(`http://localhost:8081`, `ai.openclaw.telegram-bot-api` under launchd, built
16:12-16:23 the same day). The persisted update offset (`760546622`) was a
cloud-API id. `update_id` sequences are per server: the local server's queue
began at `592426180`. The worker asked for offset `760546623`, the local
server treated it as invalid and answered from its queue head (tdlib
`Client::do_get_updates` falls back to `tqueue->get_head` when
`TQueue::get(from)` errors, "Specified from_id is in the future"), the worker
only ever raises `lastUpdateId`, so the next poll asked for the same offset.
1000 polls/s, `gateway.log` grew to 2.1 GB, gateway at 85 % CPU, and the 214
real updates behind the head were unreachable. Fixed live by stopping the
gateway, discarding the local backlog (`getUpdates offset=-1` then confirm),
rewriting the two `plugin_state_entries` rows (`telegram.update-offsets`) to
the local id space, rotating the log, restarting. Backup of the rows:
`~/.openclaw/backups/telegram-update-offsets-20260902.json`; rollback script
left by the migration author: `~/.openclaw/tba-build/rollback-to-cloud.sh`.
The bot was never logged out of the cloud API (the documented migration
step), so Telegram still queues a copy of every update there; unresolved,
Alex's call.

The code fix on this branch: the offset store records the Bot API root it was
confirmed against and rotates on a change (`api-root-changed`, alongside
bot-id and token rotation), and the ingress worker adopts the server's id
space when a poll answers below the requested offset instead of re-asking
forever, telling the session to drop the persisted watermark. Neither exists
on `upstream/main` (checked 2026-09-02, `git grep` on the offset store).

**rh-bot: macOS Local Network privacy denied the new node binary.** At 17:36
another session repointed both gateways from `/opt/homebrew/opt/node`
(26.x) to `/opt/homebrew/opt/node@24` "to match CI". node@24's code identity
has no Local Network grant on either host (`/Library/Preferences/com.apple.networkextension.plist`,
read-only), node 26's does. Under launchd, a node@24 probe resolved
`gpufarm.lan` but `fetch` failed in 24 ms; node 26 got 200 in 29 ms. SSH
shells are exempt, which is why every "works for me" probe passed. Every
model request from the gateway had hung since 17:37:52 with no error line.
Fixed by restoring the pre-node24 plist on both hosts (`engines` allows
`>=25.9.0`; native modules load under 26). Re-aligning to node 24 needs the
Local Network toggle flipped on each host's own GUI first.

**Still open on rh-bot:** the group session `agent:main:telegram:group:-5268075089`
is 3,595 events / 16 MB / ~656 K estimated tokens against a 280 K budget, one
compaction event since 2026-08-25, every turn routes `compact_only`, and a
turn takes about an hour. That is the fork's compaction-safeguard workstream
(#721-#723, `amittell/openclaw#5`), not this port.

**Follow-up noted 2026-09-03 15:48 EDT (loop monitor, measured, not fixed):**
`~/.openclaw/scheduler/scheduler.db` is 158 MB on rh-bot (`message_receipts`
261,375 rows, `job_dispatch_queue` 18,204, `idempotency_ledger` 8,215) and
114 MB on mac-mini. Neither table appears to have retention. Not a disk threat
today (rh-bot 14.3 GiB free at 93% used; that hour's drop was a Chrome 152
update plus Spotlight reindexing, measured at 0 MB/20 s afterwards), but it is
unbounded growth in an OpenClaw-owned store and belongs with the scheduler's
owner, not this port.

## 2026-09-04 00:10-02:20 EDT: rh-bot swallowed a group message for 3.5 h; disk cleanup on both hosts

**The wedge (measured on rh-bot, fixed in this branch, deployed only after the
morning restart).** Spooled event `735976357` (Alex in the RequestHub group,
2026-09-03 21:10:39) was released 106 times, backoff capped at 3 min, every
attempt ending in `Session "agent:main:telegram:group:-5268075089" changed
while starting work. Retry.` The gateway log showed only the 106 "Inbound
message" lines: the drain's `spooled update N failed; keeping for retry` notice
goes through the Telegram monitor's log router, which sends every non-`[diag]`
line to stderr, and both hosts' `ai.openclaw.gateway.plist` set
`StandardErrorPath` to `/dev/null`. The dead-letter rule needs 8 attempts AND
24 h of age, so nothing would have surfaced before 21:10 tonight.

Owner: main-session restart recovery. The entry carried
`mainRestartRecovery{revision 7, no claims/reservation/tombstone}` plus one
fence run `af0e7718` from lifecycle generation `8a53f162` (a Gateway process
that died in the 2026-09-02 17:36-22:22 restarts) with no terminal fact.
`claim_foreground` only retires fences when every run has a terminal fact
(#118873), a run from a dead generation can never record one, and with
`abortedLastRun=false` the transition falls through to `no_change`, which
`claimMainSessionRecoveryOwner` maps to `invalidated`. Fix (this branch):
`isMainRestartRecoveryAggregateTerminalOnly(entry, currentLifecycleGeneration?)`
treats a fence from another generation as settled when the caller is the
Gateway (`claim_foreground`, `observe`, and the startup-scan gate pass their
generation; `inspect` stays generation-blind so standalone callers cannot
retire a live fence). Regression: three tests in
`main-session-recovery-state.terminal-residue.test.ts`; the two Gateway-path
tests fail on the pre-fix code, the standalone control passes on both.

Live remediation (Alex, 02:05: "delete session, let the message deliver"):
`openclaw sessions delete` on the group session at 02:08 (transcript archived
to `sessions/eee12d95-….jsonl.deleted.2026-09-04T06-08-00.903Z.….zst`), the
event admitted at 02:09:45 into fresh session `a3dfb22c`, reply sent 02:13:12
(`messageId=15864`). That session was also the 670 K-token one, so the reset
Alex ordered on 2026-09-02 is now real.

**Morning deploy list:** (1) this fix; (2) both plists:
`StandardErrorPath` -> `~/Library/Logs/openclaw/gateway.err.log` so drain
notices and real errors stop vanishing (needs the same bootout/bootstrap as the
deploy); (3) the loop monitor must read stderr too.

**Disk cleanup (Alex approved tiers 1+2 at 00:05).** Both are 228 GB disks
with `nodeLinker: hoisted`, so the pnpm store never hardlinks into
`node_modules` and is a pure download cache; `pnpm store prune` removed
nothing on either host, `rm -rf` of the store did.

| host     | before               | after                | what moved                                                                                                                                                                                                            |
| -------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rh-bot   | 14.3 GiB free (93 %) | 80.0 GiB free (59 %) | pnpm store 56.9 GiB, npm cache 1.8, Chrome update clones 2.7, OpenClaw tmp 0.9, Warp 0.55; archived+removed: agent-db-backup-20260831 1.9, backups quarantines 2.0, April openclaw-backups 1.3, Aug 10 agent .bak 0.7 |
| mac-mini | 16.3 GiB free (92 %) | 46.6 GiB free (76 %) | 12 TM local snapshots (+8.7), pnpm store 21.5, Warp 1.1, npm/tmp 0.4; archived+removed: agent-db-backup-20260901 1.4, backups 1.3, backup/ 0.3                                                                        |

Archives: `/Volumes/Storage/{mac-mini,rh-bot}-archive-20260904/*.tar.gz` with
`.sha256` and `.contents.txt` beside each; sources were removed only after the
hash matched, `gzip -t` passed, and `tar -tzf` listed. Not touched: Messages
(10.7 / 28.5 GiB), Mail (8.7 / 9.8), Photos, iCloud, the stale `~/openclaw`
and `~/openclaw-scheduler` checkouts on mac-mini (tier 3, not approved), the
live checkouts' `.git` (tier 4, not approved).

## 2026-09-04 03:38-03:46 EDT: both hosts on 556e25210b4; stderr no longer discarded

Alex, 03:36: "Now, both hosts." rh-bot 03:38:17 bootout -> 03:41:40 ready
(pid 96945), mac-mini 03:42:56 -> 03:45:58 (pid 85483). Same procedure as
2026-09-02 (`deploy_host.sh`: stop, checkout, build, smoke on 18790, bootstrap);
lockfile unchanged so no install. Before each bootout the LaunchAgent plist's
`StandardErrorPath` was changed from `/dev/null` to
`~/Library/Logs/openclaw/gateway.err.log` (backup beside it,
`.bak-stderr-20260904-*`); `launchctl print` confirms the new path on both.
First hour of stderr on rh-bot: skill manifests rejected for a missing
description, AGENTS.md truncated at 20,000 chars, orphaned-user-message merges,
none of which stdout ever showed. The startup scan resumed the sessions the
bootout interrupted (rh-bot started=3, mac-mini started=2); no "changed while
starting work" on either host since.

## Carried: #721 and #723 (commit after 556e25210b4)

The fork's compaction-safeguard set is now fully on this branch: #722 was
already here (degrade fallback, fresh coverage), #721 and #723 are re-derived
by hand in `cfa10b2`'s successor commit (see `git log -- src/agents/agent-hooks/compaction-safeguard.quality-feedback-and-budget.test.ts`).
Two things learned porting them: (1) the fork's `1e6f82266c2` window-based
budget (1.25 % of the context window) was superseded three commits later by
`d71d1ee1720`'s output-bound formula, and the fork's regression suite pins the
later one, so that is what was carried; (2) this branch's
`createSummaryQualityRetentionPlan` injects audited identifiers during
finalization, so the fork's #721 scenario had to omit a section as well to
reach the corrective pass. Upstream: #722 is Alex's open PR #130393; nothing
covers #721/#723, adjacent issues are #75336, #124911, #127239, #127987. PRs
are to be prepared but not opened until Alex reviews (ruling 2026-09-04 03:30).

**Rulings 2026-09-04 03:30-04:20 (Alex):** everything in the DSH section-compaction
study gets built on this branch (increments in the session scratchpad
`dsh-increments.md`: I1 cut-point pairing + shrink invariant + leaf re-check,
I2 prune-then-remeasure, I3 recall of the shadowed span through
`sessions_history`, I4 prefix-aligned single-shot summarization, I5
exact-count admission on by default where the provider exposes a counter, I6
durable compaction-in-progress marker); compaction summaries stay on
qwen3.8-27b; upstream PRs for #721/#723 are prepared but opened only after Alex
reviews the bodies (written with the myvoice skill). Codex hit its usage limit
until 2026-09-08 21:53, so pre-land autoreview runs on the Claude engine until
then (Alex, 04:18), recorded here per commit.

## 2026-09-04 04:25-04:35 EDT: the stderr repair paid for itself in under an hour

mac-mini's gateway logged six `ENOTFOUND gpufarm.lan` model-call failures in 25
minutes, every one of them on stderr. Under the old plist they would have gone
to `/dev/null` and the only symptom would have been a `skill-workshop-review`
lane that produced nothing. Cause was not the network: the router answered
`dig @192.168.210.1 gpufarm.lan -> 192.168.210.123` while the host's own
`getaddrinfo` refused that one name three times in a row and resolved
`rh-bot.lan` normally through the same cache, so mDNSResponder held a poisoned
negative entry. `sudo dscacheutil -flushcache && sudo killall -HUP
mDNSResponder` restored it (three consecutive lookups to `.123`, `curl` 401 from
the endpoint, rh-bot agreeing on the address). Durable follow-up left for Alex:
`/etc/hosts` there already pins four gpufarm _inference_ hosts (block added
2026-07-21 "prevent coordinator DNS-flake outages") but not `gpufarm.lan`
itself, which every model call uses.

**#721/#723 review and push.** Codex is out of credits until 2026-09-08, so the
pre-land review ran on the Claude engine per Alex's 04:18 ruling: `scoped-clean`,
`patch is correct`, confidence 0.72, zero findings at any priority. It had to run
from a detached worktree pinned at `01f1fc34b42`, because autoreview verifies the
source tree after the engine returns and sibling agents were editing the main
checkout ("source changed after the review bundle was created"). Sub-P0
observations it declined to file, recorded here so they are not rediscovered: a
single pathological identifier can still overflow the 8000-char defect-list
budget across 12 items (a partial-fix limit, not a regression), and the scaled
ceiling admits summaries up to about 4x max output tokens. Branch pushed:
`github/upgrade-v2026.8.1` at `b82bde7fd9b`, verified by `ls-remote`.

Alex, 04:44: pin it on both hosts, and re-enable the 5-minute health loop after
the next deploy. `192.168.210.123 gpufarm.lan gpufarm` is now in `/etc/hosts` on
rh-bot and mac-mini with an `/etc/hosts.bak-gpufarm-pin-*` beside each; both
hosts and the router agreed on that address before the edit and three lookups
plus a 401 from the endpoint confirmed it after. rh-bot had no gpufarm pin block
at all before today.

## 2026-09-04 05:30-06:15 EDT: the DSH increments land, and the upstream branches are ready

**On this branch** (`29a818cf692`, pushed and verified by ref):

- `a74258b30ba` I1: the compaction cut point never lands inside an open tool-call
  frame; a summary that stops at the output budget is classified like empty output
  so the existing retry-once policy covers it; a commit is refused when the session
  leaf moved during summarization. 47 production lines, 197 test lines, three
  named red tests in the neutralize check.
- `de6484af41b` I3: recallable checkpoints. The compaction summary the model sees
  carries one hard-capped 160-char handle line naming the boundary and how many
  entries it shadows, derived at read time so persisted bytes are untouched, and
  `sessions_history` gains a `compactionId` mode that returns that shadowed span
  through the existing redaction, byte cap and paging. The wording that names
  `sessions_history` is injected only when that run registers the tool. Net +298
  production after a compression pass that deleted a parallel paging path, reverted
  a handler restructure, and dropped a field the page total already provided.
- `29a818cf692` a defect the review surfaced as sub-P0 and doctrine ranks higher:
  a `compactionId` read shared the anchored branch with `offset`/`messageId`, which
  deliberately falls through to the CLI-import merge, so a span request on a
  CLI-bound session silently returned the live tail and reported success. The
  decision is now `shouldReadAnchoredWindow`, which never lets a span fall through.

**Not landed: the shrink invariant (study item 5).** Implemented three ways,
including DSH's own formulation; each correctly refuses 13-14 of 27 session
fixtures, because those fixtures compact two- and three-message transcripts into
canned summaries ("condensed history") genuinely larger than the history they
replace. Making them pass by inflating fixture token counts only worked by
comparing provider-anchored "before" against heuristic "after", reintroducing the
mixed units the invariant exists to remove. It needs the fixtures rebuilt with
realistic history first. Fixture debt, not a defect in the fix.

**Upstream branches ready, no PRs opened** (Alex reviews the bodies first):
`fix/compaction-quality-feedback-defect-list` at `5ca3c72f645` and
`fix/compaction-summary-budget-output-bound` at `024b1e8f729`, both exactly one
commit on `upstream/main` at `ed79b95f44b`, verified independent of each other.
Evidence in the session scratchpad (`pr-evidence-721.md`, `pr-evidence-723.md`):
all 29 gate lanes ok on both (including plugin boundaries, which fails on THIS
branch but not on upstream), tsgo clean, autoreview scoped-clean, and neutralize
checks naming 3 and 2 red tests with an anchor control staying green in each.
Named residual: per-identifier length is unbounded in `extractOpaqueIdentifiers`,
so twelve pathological identifiers could still exceed the new 8000-char wrapper.
Neither branch has live-gateway proof; both are proved at the
`session_before_compact` boundary through the real audit, retention plan and
finalizer with a mocked summarizer.

## 2026-09-04 09:06 EDT: both hosts on 1b6e6e8b33b, health loop back, four increments in flight

**Deploy.** rh-bot and mac-mini are both on `1b6e6e8b33b` (ten commits: the
dead-generation fence fix, the #721/#723 carry, I1, I3, the compaction-span
fallthrough fix, ledger docs). mac-mini: preflight 09:01 at `556e25210b4` with
46 GiB free, lockfile unchanged, bootout rc=0, build rc=0 with zero
`[INEFFECTIVE_DYNAMIC_IMPORT]` warnings, smoke healthz 200 on 18790, bootstrap
rc=0, pid 23786, healthz 200 at 09:06:27. Both Telegram providers restarted on
their existing offsets (`373259813` default, `592427445` ratbot), so nothing was
re-fetched or dropped across the restart.

The five increment markers are present in the built chunks on both hosts, which
is the check that matters because the build splits and grepping `dist/index.js`
alone finds zero:

| marker                        | rh-bot | mac-mini |
| ----------------------------- | ------ | -------- |
| `compactionId`                | 9      | 12       |
| `shouldReadAnchoredWindow`    | 2      | 2        |
| `compaction checkpoint`       | 10     | 15       |
| `summary exceeded max tokens` | 2      | 2        |
| `changed while starting work` | 12     | 12       |

**Ingress spool, both hosts, post-deploy.** rh-bot 1000 completed / 46 failed,
mac-mini 1013 completed / 22 failed, and zero rows in any non-terminal state on
either. Every failure is `handler-timeout` dated 2026-08-24 or 2026-08-25,
predating the retry-policy change; nothing has failed since. Read off `status`,
not a guessed `deliveredAt` column - the first query I wrote used column names
that do not exist and SQLite said so, which is the good failure mode.

**Health loop re-enabled** per Alex's ruling ("1 but re-enabled after deploy"):
job `9ab3bc70`, `2-59/5 * * * *`, so it fires at :02 and every five minutes off
the :00 mark. The 10-minute fleet job `58ac593d` continues alongside it.

**Increments.** I1 and I3 are landed and deployed. I2 (prune-then-remeasure) and
I4 (prefix-aligned single-shot summarization) are in flight in their own
worktrees. I5 (exact-count admission) and I6 (durable compaction-in-progress
marker) started 09:0x. I6 carries Alex's explicit approval for a persistent-store
change and is constrained to the additive same-schema-version path in
`docs/reference/database-schemas.md` - new table or bare nullable STRICT columns,
no version bump, older-reader proof required.

**gpufarm exact tokenization** (Alex: "also add the exact_tokenize_disabled to
gpufarm / vllm"). Not yet changed. `POST /v1/tokenize` still answers 503
`exact_tokenize_disabled` for `qwen3.8-27b`. The capability is a real subsystem
in `gpufarm/exact_tokenize_proxy.py` with an authorities file, a freshness
requirement on the authority, per-request nonces, worker binding, a generation
check and a scope check, and it is default-off by design. A read-only mapping
lane is enumerating the refusal ladder and the exact enablement path before
anything is touched; this is a live shared inference gateway and the change is
GitOps, so it gets read first and edited second.

**Live proof of the compaction-span read** is running against a dev gateway on
mac-mini with an isolated state dir and its own port, never 18789 and never the
operator's state. Neither I1 nor I3 carries that proof; the fallthrough fix is
the one behavior on this branch that a unit test cannot fully settle, because the
defect only appears when a session carries a Claude CLI import binding.

**Upstream PR bodies drafted** with the `myvoice` skill, in the scratchpad as
`pr-body-721.md` and `pr-body-723.md`, following the repo template's four
required sections. Both carry the neutralize-check red test names with the reason
each went red, the anchor control that stays green, the full gate table result,
the autoreview verdict, and an explicit statement that neither has live-gateway
proof. 721's body also records the gate invocation that failed first
(`ENOBUFS` from a `--base`-less classifier diffing a 70k-commit-divergent
remote) so the green cannot be mistaken for retry-until-green. No PR is opened
and nothing is posted on GitHub until Alex signs off.

## 2026-09-04 12:40 EDT: four increments committed, and the gpufarm premise corrected

**All four remaining increments are committed on their own branches**, each in
its own worktree, none pushed, none landed. Every one reports a neutralize check
with named red tests and an anchor control that stays green, and every one
reproduced the `plugin boundaries` lane failure on a clean tree before calling
it pre-existing.

| inc                             | branch                        | commit        | production LOC | red on neutralize                |
| ------------------------------- | ----------------------------- | ------------- | -------------- | -------------------------------- |
| I2 prune-then-remeasure         | `inc/prune-remeasure`         | `0da3af82ce4` | +149 / -12     | 2 named, 3 anchor controls green |
| I4 prefix-aligned summarization | `inc/prefix-aligned-summary`  | `a571fd8dc77` | +123 / -18     | 7 named, 5 anchor controls green |
| I5 exact-count admission        | `inc/exact-count-admission`   | `421be5a1c79` | +335 / -16     | 9 of 24, plus a whole suite      |
| I6 durable start marker         | `inc/compaction-start-marker` | `9e070aee475` | +360 / -4      | 4 named, two-stage               |

Three of the four flagged something worth more than the code:

- **I2 deviated from its brief, correctly.** It was told to truncate, then
  re-measure, then decide. It measures a projection first and commits the
  persisted rewrite only once the result is known to fit, because committing
  first destroys tool output the summary was about to cover when the re-measure
  says "still over budget". It also bounded its own value: the skip can only
  fire through the per-result oversize path, never the aggregate one, so this
  helps the "a few huge tool results" case and not the general one.
- **I5 caught two of its own tests being spuriously green.** Its first
  neutralize pass showed 7 red; two more passed only because nothing called the
  counter at all. It added a call assertion and a positive control, re-ran, and
  reported 9. It also states plainly that its overflow-recovery test does _not_
  fail on pre-fix code and explains what that test is for instead.
- **I6 refused to take my word for its own approval.** Alex's approval for the
  persistent-store change reached it through me, and it recorded that it has no
  independent evidence of it and that the commit body links no decision record.
  That is the correct posture and the link needs adding before it becomes a PR.

**Live-gateway proof of the compaction-span read: done, with a premise
correction that matters more than the result.** The fix behaves as described -
a `compactionId` read returns the 135 shadowed messages, disjoint from both the
live tail and the CLI-imported rows, while `messageId` and `offset` on the same
session with the same binding return all 192 rows with `completeSnapshot`. An
unknown `compactionId` returns `ok:false`, not a silent tail. But the census
found **zero real compactions anywhere on mac-mini** across seven agent
databases and 357 session rows, so the boundary was seeded. What is real is the
175-message transcript and the entire read path in the shipped dist. The
"ten sessions with compaction checkpoints" I reported earlier were ten
`compactionCount: 0` counters. Worth knowing before anyone cites that number.

The proof also turned up why the defect needed a real CLI import to appear at
all: with a binding whose import yields nothing, `chat-history-pages.ts:431`
retries with `ignoreCliSessionImports` and answers correctly even pre-fix. The
silent wrong answer exists only when the merge actually merges.

## The gpufarm premise was wrong, and Alex caught it

I wrote that the exact-tokenize env var could be set "on the mac-mini". Alex:
"mac-mini isnt the gateway anymore, so make sure you have verified every fact
first". He is right, and here is what verification found.

`gpufarm.lan` is **192.168.210.123**, OS hostname `gpufarm`, Ubuntu 26.04.1,
Caddy on :80 fronting uvicorn. Supervised by **`systemd --user` (pid 3204)**,
not launchd and not the install-slots wrapper I cited. Gateway is pid 16815 on
127.0.0.1:8788; coordinator :8765; tierd :8766. mac-mini answers nothing.

The gateway imports **`/home/alexm/git/gpufarm-prod`** as an editable install,
`gpufarm 0.7.6`, branch `main`, head `eaf576aa703`, clean, remote
`writhub.io/alexm/gpufarm`. The exact-tokenize subsystem **is** deployed and
`@app.post("/v1/tokenize")` is live at `openai_gateway.py:5364`. All four
relevant files are byte-identical by sha256 to my local checkout, so the source
analysis holds against production.

`GPUFARM_EXACT_TOKENIZE_AUTHORITIES_FILE` is **not set in the running process**,
read from `/proc/16815/environ`. That is the entire reason for the 503, and it
is now measured rather than inferred.

Two traps on the way: reaching the host needed a known_hosts repair, and the
changed key was verified benign by hashing the entry I already trusted for
`gpufarm-new.lan` and `192.168.210.123` - byte-identical, so it is the
documented 2026-09-03 repointing and not an interception. And probing
`site-packages` for a module under an editable install is a false-negative
oracle; a positive control at the same path overturned my first answer. Recorded
in the measurement skill, dotfiles `e18688f`.

**Filed upstream** (Alex: "file these upstream in gpufarm... fully implemented
changes... test coverage and test locally before CI"): the ASGI shim's missing
source-IP gate (`client_allowed` called 0 times there against 2 in the stdlib
shim) and the coupled `exact_completion` activation
(`exact_tokenize_authority.py:486-487`). Both were confirmed unfiled against
`--state all`, which matters because `wh issue list` defaults to open and this
board is 9 open of 106.

**Blocked on Alex, DMed:** `alexm/gpufarm` is owners-only, so no distinct key
can review any row there. Already filed as gpufarm #231 with a reproduction; it
blocks four existing rows and both of mine. The remedy is an interactive
admin-scoped login only he can run.

## Decision record: I6 durable compaction-in-progress marker (persistent-store change)

`docs/reference/database-schemas.md:102` requires that a material persistent-store
change link an accepted decision, and that a new table counts as material even
when the schema version does not move. The I6 lane correctly refused to treat my
relayed approval as that record. This is the record. **Alex's acceptance so far
was given on a one-line summary, not on the design below, so the honest status is
"accepted in principle, full record pending his read".** I am not landing I6
until he confirms against this text.

**Owning store and lifecycle.** The per-agent database
(`agents/<agentId>/agent/openclaw-agent.sqlite`), which already owns
agent-scoped session state. The producer is
`AgentSessionCompaction.runCompactionWork`; both compaction entry points
converge there, so one write covers both. Rows are cascade-deleted with the
session.

**Problem.** Compaction is multi-step and only its last step is durable. A
crash, OOM kill, or Gateway restart between the summarizer call and the append
leaves no record that an attempt happened. "Never compacted" and "died
mid-compaction" are indistinguishable, so recovery cannot tell whether to
retry, whether a previous attempt already spent the summarizer budget, or
whether attempts are looping. That is the silent-failure class this repo ranks
above crashes.

**Alternatives that avoid new persistence, and why they were rejected.**
Inferring from transcript shape cannot distinguish an interrupted attempt from
a session that was never eligible. Reusing the existing `compactionCount`
counter records completions only. An in-memory marker dies with the process,
which is exactly the failure being detected. The repo's own doctrine argues for
this shape directly: "Record facts where they happen... Answering 'did X
happen?' by combining several indirect signals rots as sibling paths evolve;
prefer a recorded fact at the boundary that owns it."

**Canonical versus derived.** The row is canonical for "an attempt opened and
has not settled". Nothing else derives from it and no projection reads it. It
is not a cache and must not be rebuilt from anything.

**Schema, upgrade and downgrade.** One new table,
`session_compaction_attempts`, no column added to any existing table,
`OPENCLAW_AGENT_SCHEMA_VERSION` unchanged at 19. Qualifies as additive at the
same version per `database-schemas.md:33` ("New tables qualify because older
builds ignore them"). Declared in the canonical schema plus a one-time
idempotent lazy ensure on first feature use, mirroring
`ensureSessionGoalOperationsSchema`, and registered in
`AGENT_SCHEMA_COMPATIBILITY.allowedMissingTables`. Downgrade proof is in the
lane's test: an older reader opens the database, uses it, and writes, with
`PRAGMA user_version` and the `schema_meta` row unchanged, and a candidate
reopen sees the same state.

**Retention and deletion.** One row per session, replaced by each new attempt,
removed with the session by foreign-key cascade. No growth term, no sweeper.

**Concurrency and recovery invariants.** The ensure runs outside the write
transaction; no `await` occurs inside any transaction callback
(`check-sqlite-transaction-boundary.mts` passes). The mark carries its own
scope so a settlement lands on the session the attempt opened against. All row
access is Kysely, not raw SQL.

**Visibility.** The next compaction decision after a restart claims the
unsettled row once per session and emits the existing `compaction_end` with
`{status:"failed"}` - the shipped WARN log and agent event, no new event type.
The lane checked that a `failed` outcome with no preceding `compaction_start`
has no harmful side effects.

**Rollback.** Revert the commit. The table is then unread and inert; older
readers already tolerate its presence, so no migration is needed to back out.

**Validation limits, stated rather than hidden.** No live Gateway or Control UI
proof: the `compaction_end` path is proven at the session-event boundary only,
so whether an operator actually notices the WARN line is untested against a
real surface. `interrupted_attempts` records a streak but drives no policy;
nothing yet refuses to retry after N interruptions. `pnpm lint:core` did not
complete - its runner timed out at 900s, which is an infrastructure timeout and
not a reported violation - so the substitute was the targeted oxlint command
`check-changed` builds for the same files, which passes.

## 2026-09-04 13:0x EDT: both upstream PRs opened after a validity re-check

Alex signed off on the bodies and asked for them to be pushed "if they are still
valid". They are, and the check is worth recording because the first attempt at
it produced a false clean.

**Validity, measured against every current upstream ref.** Both defects are live
on `upstream/main` (`6a97159ecec`), on `v2026.8.2`, on `v2026.9.1`, and on the
untagged in-flight `upstream/release/2026.9.2`:

- #721: `missingIdentifiers.slice(0, 3)` is still present in
  `compaction-safeguard-quality.ts` on all four refs, and
  `wrapUntrustedQualityFeedbackBlock` exists on none of them.
- #723: `MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2)`
  is still the fixed derivation at `compaction-safeguard.ts:87`, the constant is
  still used directly as the finalization budget at `:1043`, and
  `resolveCompactionSummaryBudgetChars` exists on none of them.

Both branches still merge clean onto current `upstream/main` by
`git merge-tree --write-tree`, rc=0 each.

**The false clean, recorded because it nearly settled the question the wrong
way.** My first sweep reported `slice(0,3)=0` on every ref, which reads as
"upstream already fixed it". The positive control in the same output said
`auditSummaryQuality=0`, which is impossible for that file, and that is what
exposed it. Cause: `git show "$ref:src/agents/..."` in zsh, where `:s` is the
substitute history modifier, so the pathspec was mangled before git saw it.
Braced as `"${ref}:src/agents/..."` the control returns 1 and the real answer
appears. Alex's `CLAUDE.md` already carries "Git object paths: `${sha}:path`;
`$sha:path` invokes parameter modifiers", and having the rule written down did
not stop me - only the control did. A second seat hit the identical trap on the
same day with `"$H:crates/..."`.

**Upstream issue search.** No open issue covers either defect. The nearest is
`#119272` (closed, completed), a different failure in the same file: the
appended suffix filling the 16,000-char budget and silently replacing the
summary body, fixed on main by `#123827`. Ours is the adjacent defect - the
budget itself being fixed at 16k regardless of session size - so `#119272` is
referenced as `Related:` on the budget PR rather than claimed as closed by it.
`gh search issues` rejects `--state all`; it takes open or closed only, and
omitting the flag searches both.

**Opened, following the merge-ref race procedure in `CLAUDE.md`:** created as
drafts, polled until `mergeable` went non-null (True on both, `mergeable_state`
unstable while CI runs), marked ready, then confirmed check runs attached to
each head SHA.

| PR                                                          | branch                                        | head          | files | diff     |
| ----------------------------------------------------------- | --------------------------------------------- | ------------- | ----- | -------- |
| [#138415](https://github.com/openclaw/openclaw/pull/138415) | `fix/compaction-quality-feedback-defect-list` | `5ca3c72f645` | 3     | +244/-2  |
| [#138416](https://github.com/openclaw/openclaw/pull/138416) | `fix/compaction-summary-budget-output-bound`  | `024b1e8f729` | 3     | +339/-21 |

`maintainer_can_modify` is true on both, so maintainers can push to the
branches. Both bodies state plainly that neither carries live-gateway proof and
that the boundary proof is a mocked-summarizer run through the real
`session_before_compact` handler.

Stale branches on the fork that must NOT be opened as PRs, since they are
superseded shapes of the same work: `fix/compaction-quality-feedback-truncation`
(`1e6f82266c2`, the window-based budget that `d71d1ee1720` replaced) and
`fix/compaction-safeguards-721-722-723` (`df808efca37`).
