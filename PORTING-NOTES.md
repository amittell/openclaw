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
