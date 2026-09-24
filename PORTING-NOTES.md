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

> **SCOPE, measured 2026-09-15 on `upgrade-v2026.9.4`.** This table describes the
> **8.1** tree it was written for. It is NOT a description of this branch, and the
> later carries did not preserve it: of the eight sibling files it names, four are
> absent here (`ack-parts.ts`, `cooldown-probe.ts`, `run-loop.exhaustion.ts`,
> `settled-turn.ts`) and none of those four exists on the 9.3 line either, so they
> were dropped when 9.3 and 9.4 took upstream's file layout rather than lost in one
> carry. One survives renamed: `auth-controller.cooldown-probe.ts`. The splits'
> PURPOSE is also undone — `oxlint` reports **9** `max-lines` errors across
> `src ui packages extensions` on this branch, including `server-close.ts` 724,
> `terminal-resolution.ts` 725 and `message-tool-execution.ts` 721, all against a
> cap of 700. (An earlier revision of this note said 2: that count came from
> linting only the two files being edited at the time and was a property of the
> command, not of the repo. The 9 and their provenance were measured by
> `claude-air-opus5-f8e98e`, who also established that all nine were UNDER cap at
> `v2026.9.2` and the fork's own diff tipped every one — `get-reply-inline-actions.ts`
> crossed on a single added line.) Note `scripts/check-max-lines-ratchet.mts` exits
> 0 on all nine: it enforces shrink-only on `config/max-lines-baseline.txt` and
> never asks whether an unledgered file is under budget. Treat every row below as
> history, not as a claim about files you can open.
>
> **CORRECTED 2026-09-16.** The sentence above is true and was read as more than it
> says. The ratchet is **not** the cap check and never was: `scripts/check-changed.mts`
> schedules a targeted oxlint run for changed `src/` paths
> (`createTargetedCoreLintCommands`, with a `lint:core` fallback), and oxlint enforces
> the 700-line cap, so the changed-files lane **fails** an over-cap commit. A green
> ratchet is not a green cap; neither is it evidence that nothing checks the cap. The
> open question is why over-cap files landed past a lane that would reject them - a
> candidate, unconfirmed, is that nothing currently runs that lane on this branch.
>
> **The count above is also stale.** Whole-repo scan at `1d541021b78`
> (`node scripts/run-oxlint.mjs src ui packages extensions`, 31,434 files): **12
> production files** over the 700 cap plus `src/media/store.test.ts` over the 1000
> test cap, none in the baseline, all with fork deltas against `v2026.9.4`. Largest:
> `server-close.ts` 777, `session-accessor.sqlite-history-events.ts` 746,
> `chat-history-handler.ts` 720. Tracked in issue #9.

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

## 2026-09-04 13:30 EDT: two gpufarm findings filed, and two corrections to my own claims

**Both design findings are filed upstream in `alexm/gpufarm` with implemented
fixes, tests and green CI**, per Alex's ruling "fully and foundationally fix it
... make sure there is test coverage and test locally before CI".

| finding                                        | issue                                               | change                                               | production LOC     | neutralize                       |
| ---------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | ------------------ | -------------------------------- |
| ASGI shim has no source-IP gate                | [#329](https://writhub.io/alexm/gpufarm/issues/329) | [#331](https://writhub.io/alexm/gpufarm/changes/331) | +98/-33, code +30  | 6 red, 9 anchor controls green   |
| `exact_completion` coupled to `exact_tokenize` | [#328](https://writhub.io/alexm/gpufarm/issues/328) | [#330](https://writhub.io/alexm/gpufarm/changes/330) | +125/-63, code +33 | 10 red, 19 anchor controls green |

Both were confirmed unfiled against all 107 issues and 220 Changes read with
`--state all` plus per-issue GETs, since the list endpoint carries neither body
nor thread. `wh issue list` defaults to open-only, which is 10 of 107 here.

**Correction 1, severity of the ASGI gap.** I recorded it as the shim lacking
the source-IP gate, which reads as an open port. It is a **latent cutover
regression**: no live deployment runs `shim_asgi` today (`runner.py:284` serves
the stdlib shim, no production caller of `make_app` exists in-tree, and
`kebab-rtx6000` runs its own FastAPI router which enforces
`KEBAB_RTX_RESTRICT_MODEL_API_CLIENTS=1` right now, read from the live
`/proc/<pid>/environ`). It still matters because `shim_asgi` is the transport
that router is meant to migrate onto, and because `runner.py` wires neither
`GPUFARM_API_KEYS` nor `GPUFARM_AUTH_REQUIRED`, so `client_allowed` is the only
admission control the shipped entrypoint can enable. Brain corrected.

**Correction 2, the coupling is bidirectional and worse than I briefed.**
`_parse_authority` required the four `completion_*` fields, so a tokenize-only
authority could not be expressed at all, and a missing completion key silently
withdrew the tokenize advertisement too. The "deliberate" hypothesis is refuted
rather than merely unsupported: `same_worker_binding_sha256` never references
the tokenize path, and the gateway-side authority carries no completion fields,
so tokenize already stands alone there.

**Correction 3, my own scoping of the maxTokens finding.** I wrote "this fleet"
and "the deployed config". Wrong denominator. The values live in
`~/.openclaw/openclaw.json` at `models.providers.gpufarm.models[0]` on the two
OpenClaw bot hosts ONLY - 265000 appears nowhere in `src/` or `packages/`. DSH
declares `maxTokens: 32768` against a 262144 window, a real output cap, so a
seat reading my claim would have wrongly distrusted a correct config. Caught by
another seat that could check DSH and I could not.

The two bots also differ from each other, which I had flattened:

    rh-bot     maxTokens=265000  contextTokens=300000  contextWindow=1010000
    mac-mini   maxTokens=265000  contextTokens=none    contextWindow=262144

So the ceiling our #723 formula produces (1,059,616 chars) is about 88% of
rh-bot's declared window and about **101% of mac-mini's** - it exceeds the whole
context there. I had reported 88% for both.

Unresolved and not touched: rh-bot's `contextWindow: 1010000` matches the vLLM
`--max-model-len 1010000` in gpufarm-manifests for `qwen38-27b-nvfp4`, while
mac-mini's 262144 does not. Same model id, same endpoint, two declared windows,
one of them under-declared relative to what the server serves. The dsh-ops skill
records that an under-declared window wedges every large session.

## 2026-09-04 14:15 EDT: the truncated-summary guard was one-sided, and now is not

`a74258b30ba` taught `runSummarizationCompletion` to reject a summary whose
`stopReason` is `length`, because a body cut off at the output budget is
structurally incomplete. It did not touch the sibling. `generateBranchSummary`
handled only `aborted` and `error`, so a truncated branch summary fell through
to `extractSummaryText`, came back non-undefined, and was committed. Same
defect, same consequence, shipped to both bots in the same deploy.

`CLAUDE.md` names this exact case: "One-sided fixes need sibling-surface proof,
an explanation for why siblings are unaffected, or explicit follow-up work." I
provided none of the three at the time. The upstream sweep found it, not me.

**Reproduced rather than argued.** Pre-fix, `navigateTree` resolved and
committed a summary ending mid-heading:
`## Goal\nRewrite the parser\n\n## Progress\n### Do`.

**"Deliberate?" was settled by the path's own contract, not the sibling's.**
`sdk.test.ts:406` already pins that a branch summary with no usable text
REJECTS `navigateTree` and commits nothing. The path had already chosen
fail-closed for unusable output; it simply did not count truncation as unusable.
The branch output cap is a hard 2048 tokens, so `length` is reachable in
ordinary use, and the `## Next Steps` / `## Key Decisions` sections the template
promises come last, so they are what a truncation removes.

**Fixed by absorbing, not by branching.** Both handlers now call
`readSummaryCompletion` in `compaction/utils.ts`, which returns the text or a
closed failure kind; each caller maps to its own error vocabulary, so every
existing code and message string is byte-identical. Both shapes were measured
rather than assumed: the shared owner is **+62/-49 = net +13** production, the
branch-only guard would have been **+11** and kept the duplicate that had
already drifted once. Three lines for an ownership boundary.

`src/agents/sessions/compaction/branch-summarization.ts` needs nothing: it is a
host bridge that flattens the `Result`, so a truncated summary now reaches it as
the same `{error}` shape it already returned for empty output.

Commit `3ef37bc19c5` on `fix/branch-summary-length`, not pushed, not landed.
Red tests, both named with their assertions: agent-core `rejects a summary cut
off at the output budget` (`expected true to be false`), and host
`refuses to commit a branch summary stopped at its output budget` (expected a
rejection, got a resolved entry ending `### Do`). Anchor control
`commits a branch summary that finished within its output budget` green on both
sides. Gates ran on the M4 with the host stamped on every run; `plugin
boundaries` output compared byte-identical against a clean-tree control.

**Named follow-up, not fixed:** the host bridge is reachable only through the
`sessions/index.ts` and `extension-sdk.ts` barrels, while the real consumer
`agent-session-tree.ts` calls agent-core directly via
`normalizeBranchSummaryResult` - two parallel adapters for the same mapping.
Consolidating touches an extension-facing barrel export, which is a public
surface decision outside this invariant.

**Landing queue, all unlanded pending validation:** `inc/prune-remeasure`,
`inc/prefix-aligned-summary`, `inc/exact-count-admission`,
`inc/compaction-start-marker`, `fix/branch-summary-length`. Each needs a fresh
`autoreview` before landing per `CLAUDE.md`, and gate capacity is the current
constraint: the Air is barred for suites and the M4 is at 98% container use.

## Rebase hazard: our span fix and upstream's anchor fix are complementary, and a careless merge drops ours silently

Measured 2026-09-04 against `upstream/main`.

Upstream landed `f3652df7492` ("fix: return empty history for missing CLI-import
anchors", #136720, steipete, 2026-09-02). It is **not in our fork** and it
converges on the SAME invariant as our `29a818cf692`: an anchored read must not
be answered with the live tail. But it is `messageId`-scoped only.

    upstream/main  chat-history-pages.ts   occurrences of `compactionId`:  0

So upstream cannot guard a compaction span, because the feature does not exist
there. **Both fixes are needed; neither subsumes the other.**

The mechanical trap. `f3652df7492` also **un-exported**
`capOffsetChatHistoryProjectedMessages` and deleted its use as a fallback:

    ours       session-history-tail.ts:27   `export function capOffset...`
    upstream   session-history-tail.ts:27   `function capOffset...`      (no export)

    ours       chat-history-pages.ts:16     imports it
    ours       chat-history-pages.ts:378    `?? capOffsetChatHistoryProjectedMessages(projected, max)`
    upstream   removed both

Two ways this goes wrong on rebase, and only one of them is loud:

1. Upstream's `session-history-tail.ts` wins while our `chat-history-pages.ts`
   survives -> the import has no export to bind and the build fails. Loud, fine.
2. Upstream's `chat-history-pages.ts` hunk wins -> the import and the fallback
   both vanish, the tree compiles, **and our `shouldReadAnchoredWindow` extraction
   can go with it**. Silent, and it restores the exact defect `29a818cf692` was
   written to remove: a span request answered with the live tail while reporting
   success.

**Resolution instruction for whoever rebases.** Take upstream's removal of the
`capOffset...` fallback and its un-export - that is their deliberate design.
Keep OUR `shouldReadAnchoredWindow`, and re-apply the span term on top of
upstream's `messageId` guard rather than instead of it. After resolving, assert
both by grep before trusting the build:

    grep -c 'compactionId' src/gateway/server-methods/chat-history-pages.ts   # must be > 0
    grep -c 'shouldReadAnchoredWindow' src/gateway/server-methods/chat-history-pages.ts

A clean `merge-tree` on these files is not evidence the span guard survived.

## Undeclared: our cut-point fix changes shipped plugin-SDK behaviour

Measured 2026-09-04. Not a defect in the fix, but a fact that must be declared
if I1 is ever offered upstream, and one neither the commit nor the ledger stated.

`a74258b30ba` changed `findValidCutPoints` so a cut point strictly inside an open
tool-call frame is skipped. That function has one caller inside agent-core:

    packages/agent-core/src/harness/compaction/compaction.ts:448  export function findCutPoint(...)
    :454                                                          const cutPoints = findValidCutPoints(...)

and `findCutPoint` is re-exported on the plugin SDK barrel:

    src/plugin-sdk/agent-core.ts:39   findCutPoint,

It is present on that barrel at **both `v2026.8.1` and `v2026.9.1`**, so by this
repo's own definition - "Shipped means reachable from a stable release Git tag" -
it is shipped public API.

**The observable change for an SDK consumer.** No signature change; the returned
`firstKeptEntryIndex` moves. Before, a transcript whose candidate cut sat between
an assistant's tool call and its `toolResult` could be cut there, splitting the
pair across the summary boundary. Now the scan tracks open calls with
`createToolCallOccurrenceQueue`, clears them at each assistant, claims them at
each `toolResult`, and skips any candidate while calls remain open - so the cut
lands at a pair boundary instead.

**My reading, not a ruling:** this is a bug fix rather than a compat break,
because the old value was an invalid cut point and a plugin depending on it was
depending on a defect. But `CLAUDE.md` treats plugin SDK surface as
compatibility-sensitive and asks for the count and direction of such changes in
review. We declared neither. Whoever offers I1 upstream - the sweep names
`#127987` (OPEN, P1, `no-new-fix-pr`, review already describing this exact fix,
no PR yet) as the target - must state in the PR body that `findCutPoint`'s
returned index changes for tool-pair transcripts, and should carry a test at the
SDK boundary rather than only at the internal one.

Neither open PR is affected: `#138415` and `#138416` touch the safeguard, not
agent-core's cut-point scan.

## Upstream's regression test for the fence defect does not cover the defect

Verified 2026-09-04 against `upstream/main`. This is the argument to lead with
if `cfa10b22ee3` is ever offered upstream, and it is unusually clean.

Upstream's `main-session-recovery-state.terminal-residue.test.ts` is the
regression coverage for #118873 (fixed by #126671). Its fixtures are labelled
with dead generations, which makes the case look covered:

    restartRecoveryRuns: [{ runId: "settled-run", lifecycleGeneration: "dead-generation" }]

**But the same fixture also writes:**

    restartRecoveryTerminalRunIds: ["settled-run"]

So the run carries a terminal fact, and upstream's predicate retires the
aggregate on THAT, not on the generation. The `dead-generation` string does no
work in any assertion; swap it for `generation-1` and every test still passes.
The label reads as coverage and is decoration.

**The case that still wedges a session is the one the fixture never builds:** a
run whose `lifecycleGeneration` belongs to a Gateway process that is gone AND
which has no terminal fact - because it cannot record one, the process that
would have written it died. `#126671` shipped only the all-runs-terminal half of
the criterion that `#118873`'s own body proposed. Ours adds the generation arm:

    runs.every((run) =>
      hasRestartRecoveryTerminalRun(entry, run.runId) ||
      (currentLifecycleGeneration !== undefined &&
        run.lifecycleGeneration !== currentLifecycleGeneration))

That is the wedge rh-bot hit on 2026-09-04, which swallowed a group message for
three and a half hours behind "changed while starting work" - the exact string
upstream's own test comment names as the symptom it is preventing.

**Offer target**, per the sweep: `#118839` (OPEN, `needs-live-repro`, and we have
the repro) or `#117096` (closed `not_planned`, whose closing comment concedes
"the central bug remains on current main"). Any such PR must carry a fixture
with a dead generation and NO terminal run id, since that is the case the
existing suite cannot express.

## Both upstream PRs are P1-blocked, and the two fixes are specified

Reviewed 2026-09-04. Both findings are correct and both are the same error:
I asserted a bound after reasoning about typical content, never worst-case.

### #138415 - the 8,000-char feedback cap can still truncate

Measured at `compaction-safeguard-quality.ts:395-407`. The extractor caps the
COUNT (`.slice(0, MAX_EXTRACTED_IDENTIFIERS)`, 12) and filters a MINIMUM
(`value.length >= 4`). There is no maximum, and the first alternation branch is
`https?:\/\/\S+` - greedy across all non-whitespace. Twelve long URLs overflow
8,000 chars and the block is cut mid-item, which is exactly the defect the PR
removes.

**Specified fix, and the shape matters.** Do NOT truncate an identifier: a
partial identifier is a wrong identifier, and the corrective pass needs the exact
string to restore it. Instead emit only WHOLE identifiers that fit the budget and
state how many were omitted. That converts a silent mid-item cut into a recorded,
visible non-outcome, which is what the product doctrine asks for
("every action ends in a visible outcome or a recorded, intentional
non-outcome"). With unbounded identifier length no fixed budget can show all
twelve, so the honest contract is "these N complete, M omitted" rather than a
pretence of completeness.

### #138416 - the character ceiling is not a token ceiling

`CHARS_PER_TOKEN_ESTIMATE` (4) and the CJK-aware `estimateStringChars` live ten
lines apart in `packages/normalization-core/src/cjk-chars.ts`. The estimator adds
`CHARS_PER_TOKEN_ESTIMATE - 1` per common CJK character, so replay charges CJK at
roughly one token per character. Our 120,000-char ceiling is ~30,000 tokens of
English and ~120,000 of Chinese: 40% of a 300k window, not the 10% the PR body
claims.

**Specified fix.** Stop approximating. The budget is applied at finalization
where the summary text exists, so bound it in TOKENS using the same estimator the
replay uses, rather than converting through a constant that matches only for
ASCII. Simpler than what is there now, and it makes the asserted invariant true
by construction instead of by assumption.

### Second blocker on both: real behavior proof

Both were declared without live-gateway proof and the reviewer treats that as
blocking. The repo defines a satisfying form - a mock-gateway harness run with
the verdict JSON in the PR body - so this does not need a live channel.

**Neither fix can proceed until a gate host is available.** The Air is barred for
suites, the M1 measured load 62 on 10 cores, and the M4 is at 2.0% container free
partly because my own lanes added ~1 GB to its pnpm store. `pnpm store prune` is
the reversible remedy and is with Alex.

## Carry-forward audit for the 9.x rebase (Alex, 2026-09-04: "all the pi and DSH enhancements... and all our PRs that aren't covered upstream both open and closed... once validated with evidence they are needed")

Two read-only lanes plus my own checks. Target confirmed as the 9.x line.

### The PR population

75 PRs authored by `amittell` on `openclaw/openclaw`, cross-checked three ways
(GraphQL `author:`, `gh pr list --state all`, and `involves:` minus four he only
commented on). **8 merged, 57 closed unmerged, 10 open.** All 8 merged are
already ancestors of both `upstream/main` and our branch, so they need nothing.

**The finding that matters: 21 of the 57 closed PRs carry only the bot's
queue-cap message** ("more than 10 active PRs") and no technical verdict at all.
That is where the live work is - not in the ones a maintainer actually refused.

### Rebase surface, measured

- 143 fork production files changed vs the base tag (+5,412/-928), plus 93 test
  and 10 docs files.
- **86 of those 143 were also changed upstream** - the real conflict surface.
  57 should apply cleanly.
- **0 add/add collisions.** Exactly one fork-modified file upstream deleted:
  `src/auto-reply/reply/commands-subagents.test-helpers.ts`.
- Only **2** genuinely fork-added `OPENCLAW_*` env names. The other 14
  "fork-only" names are ones upstream DELETED and the fork inherited - check
  those references survive.
- **`v2026.9.1` is a release branch too**, 41 commits main lacks and 961 behind
  main, so "upstream has this" remains two claims at the new target as well.
  One verdict differs between them: `capOffsetChatHistoryProjectedMessages` is
  still exported at `v2026.9.1` and un-exported on `main`.

### Strongest to offer upstream, in order

1. **`ee97d524e50` cron fallback pin.** Provably live upstream:
   `run-finalize.ts:152-163` writes the fallback tuple back unconditionally and
   `isFromFallback|usedFallback` returns zero across `upstream/main:src/cron/`
   (control: `setCronSessionRuntimeModel` 8 hits / 3 files). Needs reshaping -
   upstream's `CronExecutionResult` lacks the fields the fork compares against.
2. **`cfa10b22ee3` dead-generation fence**, with the vacuous-coverage argument
   already recorded above. Targets `#118839` (open, `needs-live-repro`, and we
   have the repro) or `#117096`.
3. **`2276250b531` Bot API root offset scoping.** Absent upstream, fixes a
   measured incident, but bumps `STORE_VERSION` 3->4 so it goes through the
   persistent-store gate first.
4. **`#101866`** - and offer the PR head `6876d240238`, which is AHEAD of what
   the fork carries, not the fork's narrower `redactUngroundedMediaRefs`.

### Must NOT be re-offered

- **`#100493`** - its cap reads `pendingFinalDeliveryAttemptCount`, which
  `projectCanonicalSessionEntryShape` destructures out at
  `store-entry-shape.ts:61` and never re-adds, and which sits in
  `RETIRED_SESSION_SLOT_KEYS`. Nothing writes it, so the cap reads 0 forever: a
  safeguard that can never fire but looks like one.
- **`#66912` and the self-authored half of `#126789`** - he withdrew #66912
  citing a test that pins the opposite, and **that test still exists**, renamed
  into an `it.each` at `bot.test.ts:4577`. #126789's diff inverts that assertion
  under a title describing only the dedupe. Split it: the `fileUniqueId` dedupe
  is a genuinely different defect and is fine.
- **`#56517`/`#56532`** - steipete: "We are intentionally not adding new public
  timeout or retry config knobs here." **Our `embedding.fallbackBaseUrl` falls
  inside that ruling.** Keep it locally; do not upstream it as config.
- **`#130400`** - a maintainer ran the real flow and found the opposite symptom.
  Re-offering the identical patch-id spends credibility.

### Cleanup the rebase should carry

- Delete the dead `isFromFallback` residue in `session-store.ts` (89, 143-145,
  152, 180, 198) - upstream's `post-run.ts:177-182` forces it false, so it is
  unreachable.
- Relax the fork's own `validateProfileId` (the pre-relaxation 128-char
  allowlist at `sanitize.ts:37-38`) before shipping `models auth clean`.

### Two hazards beyond the PR list

- **The Codex turn watchdog is an architecture upstream deleted.**
  `isReasoningProgressNotification`, `postToolProgressNeedsTerminalGuard` and the
  `CODEX_*_IDLE_TIMEOUT_MS` family are all 0 at `upstream/main`, replaced by
  terminal settlement. Expect a large conflict; do not carry the old model
  forward by default.
- **`#75336` (SebTardif, open, +1097/-21) touches exactly our two compaction
  files.** It does not duplicate ours semantically but heavily rewrites
  `extractOpaqueIdentifiers`. Whichever lands second rebases.

### DSH

DSH upstream accepts no external PRs at all - `CONTRIBUTING.md`, issues
disabled, zero PRs ever. So for every DSH-fork item "has upstream absorbed it"
is structurally **no**, and the only real question is supersession.

### A numbering trap

Two independent schemes exist and they disagree. The scratchpad calls
prune-then-remeasure "#4"; the original study's ranked table lists it **#3** and
gives #4 to the shrink invariant. Use the descriptions and owner files as the
key, never the numbers.

## The summary budget is overridden downstream, so #138416 cannot change shipped behaviour as written

Found 2026-09-04 while fixing the CJK finding, verified by reading the call site
rather than taking the lane's word.

`src/agents/sessions/agent-session-compaction.ts:276`:

    compactionResult = {
      ...compactionResult,
      summary: capCompactionSummary(compactionResult.summary),
    };

That call passes **no explicit limit**, so it takes
`maxChars = MAX_COMPACTION_SUMMARY_CHARS` (16,000 raw chars) from the signature
default at `packages/agent-core/src/harness/compaction/compaction.ts:118-122`.
It sits **outside** the extension branch, so it applies to the safeguard
extension's output exactly as it applies to core's.

So the whole #723/#138416 line of work raises a budget upstream of a fixed
16,000-char cap that then truncates the artifact anyway. **The PR's tests pass
because they assert on the hook's return value, which is upstream of this cap.**
They are honest about what they measure and simply never reach the persisted
artifact. That is also why every one of our neutralize checks was green on the
fix and told us nothing about production.

**It sharpens the original problem statement.** The order is AUDIT, then
TRUNCATE. `auditSummaryQuality` runs inside the safeguard and passes on the full
text; the cut happens after the hook returns. So the artifact a session replays
is not the artifact that passed the audit, and a corrective retry cannot help -
regenerating produces another summary that passes and is cut in the same place.
Our PR body described the truncation as happening _before_ validation, which is
the wrong way round.

Two mitigations, recorded so the finding is not read as worse than it is:
`capCompactionSummary` appends `SUMMARY_TRUNCATED_MARKER`, so the truncation is
visible rather than silent; and nothing on either bot reaches this path at all,
because compaction has never run on either (zero `compaction_start` and zero
`compaction_end` across 5,000 log lines per host).

**Not changed, and deliberately.** Aligning that cap to the resolved budget
changes what is persisted for every session on every host. That is a persistence
decision under this repo's rules, not something a budget fix should carry
unannounced. Disclosed in the PR body and put to Alex. If the cap should take the
resolved budget, it is a small change; if the cap is deliberate, #138416's
premise needs rethinking rather than merging.

Also fixed and pushed today on that branch: the CJK ceiling, at `6f06c1d3f06`.
A 60,000-char Chinese body went from 63,910 replay tokens (21.3% of the window)
to 29,565 (9.86%), with the Latin twin unchanged as an anchor control.

## Post-carry validation: full suite, and the one defect it found

Full suite on `upgrade-v2026.9.2`, 297 shards, ~3h20m on the Air (Node v22.23.1).
15 distinct test files failed. Final classification, every verdict measured:

| files | verdict          | how it was established                                                      |
| ----- | ---------------- | --------------------------------------------------------------------------- |
| 1     | **carry defect** | fails ALONE on the branch, passes ALONE at the tag                          |
| 11    | inherited        | fails identically on a clean `v2026.9.2` worktree, zero carry               |
| 3     | load artifact    | passes ALONE on the branch AND at the tag; only fails inside the full suite |

### The defect: trap 5, an upstream extraction kept twice

`src/skills/runtime/refresh.test.ts`. 9.2 moved four Windows watcher tests into a
new `src/skills/runtime/refresh.windows.test.ts` and deleted them from the
original; the carry re-added the 8.1 inline copy alongside upstream's new file.

    v2026.8.1          refresh.test.ts: 4 tests    refresh.windows.test.ts ABSENT
    v2026.9.2          refresh.test.ts: 0          refresh.windows.test.ts PRESENT
    upgrade-v2026.9.2  refresh.test.ts: 4 <- ours  refresh.windows.test.ts PRESENT

The fork copy failed with `expected undefined to match object`: it creates its
fixture dirs only at the SHORT path and relies on a realpath mock, while 9.2's
extracted version also creates them at the expanded path and asserts `watchRoot`
exactly. Upstream's file is a strict superset - the same four scenarios plus
`it.runIf(process.platform === "win32")("keeps a missing drive-child root
anchored absolutely")`, which the fork never had.

**Fix: delete the fork's inline block and the `MockInstance` type import it alone
used.** `refresh.test.ts` is then byte-identical to upstream 9.2, which is correct
because the fork had no other delta in it. Production LOC 0, test LOC -69, zero
coverage lost. Verified: 42 ran / 0 failed, plus 5 / 0 in the extracted file.

Swept the whole carry for the same class rather than assuming it was unique:
**71 carry-modified test files, 137 added test names, exactly 1 duplicate.**

### Two instrument failures worth carrying forward

**The naive control changes two variables.** A tag-worktree control runs each file
ALONE on a quiet machine; the branch result came from a 297-shard suite under
contention. Three `test/scripts` files passed the control and failed the suite,
which reads as "the carry broke them". It did not - all three pass ALONE on the
branch too. Their failures were 10115 ms, 15923 ms and a 396 ms race, i.e. all
timing-shaped. **The discriminator is running the suspects alone on your own
branch**, so only the tree differs.

**The duplicate detector had a systematic blind spot.** Matching `it(` and
`it.each(...)(` misses `it.runIf(...)`, `it.skipIf(...)` and multiline
`it.each([...])` - measured at 590 of 45,491 names (1.3%) over 4,000 tag files,
and the misses cluster on exactly the platform-conditional tests a cross-platform
carry is most likely to duplicate. Re-run with a corrected extractor plus
`git grep -F` for the lookup half; the answer held at 1.

### Known-failing at the tag, not ours

`pnpm check:changed` fails one lane, `plugin boundaries`, with
`1 compatibility record(s) are due for removal`. Identical on a clean
`v2026.9.2` worktree (`eligibleForRemoval=1`, exit 1, same counts): a
date-driven deprecation window that came due. Retiring a compat record is a
product decision, not a carry fix. All other lanes pass, format included.

---

# Carrying onto v2026.9.3 — measured plan

Measured 2026-09-10 from `a2cd501130c` (the fork head on the 9.2 base, both bots
deployed and verified). **Every number below is measured, not estimated.** An earlier
figure of "70 files need hand resolution" was published and is WRONG — see the
instrument note at the end.

## Topology: 9.3 is not a patch bump, and not ancestral

    merge-base(9.2, 9.3)        b6a2e5b4eff   2026-09-05
    commits only in v2026.9.3   1899
    commits only in v2026.9.2      5          all release scaffolding
    9.2 -> 9.3                  10681 files, +682k / -376k
    commit mix in 9.3           913 fix, 435 refactor, 201 perf, 148 test, 55 feat
    top areas                   src/agents 1267, ui/src 1188, src/gateway 842, src/infra 456

Neither tag is an ancestor of the other. They are sibling release branches that
diverged 2026-09-05, so this is a re-anchor exactly like 8.1 -> 9.2, not a fast-forward.

## Cost: SMALLER than the carry we just completed

Replaying our delta per file with the ledger's method
(`git merge-file -p --diff3 <9.3> <9.2> <ours>`):

    files with a carry delta vs 9.2 .... 258
    replays CLEAN onto 9.3 ............. 189
    needs HAND resolution ..............  28
    relocated/absent in 9.3 ............   1
    fork-only files (copy over) ........  42

    8.1 -> 9.2   45 files hand-resolved   (what the 2026-09-09 carry actually cost)
    9.2 -> 9.3   28 files hand-resolved   (projected, same method)

**And the true hand count is 23, not 28**, because five of them are not hand work:

    3  test/fixtures/agents/prompt-snapshots/**   regenerate: pnpm prompt:snapshots:gen
    2  config/assertion-safety-baseline.txt       mechanical; --prune is shrink-only
       config/env-var-count-budget.txt            mechanical; owner approval to raise

## The 23 real files, by difficulty (conflict hunks | our added lines)

    6 |  74 | src/agents/embedded-agent-runner/run/auth-controller.ts      <- the only hard one
    3 |  18 | src/agents/embedded-agent-runner/run/failover-retry-controller.ts
    3 |  12 | extensions/telegram/src/monitor.ts
    2 |  40 | src/agents/auth-profiles/store.ts
    2 |  30 | src/agents/embedded-agent-runner/run/helpers.ts
    2 |  13 | src/gateway/local-http-probe.ts
    2 |   7 | src/agents/embedded-agent-runner/run/auth-controller.test.ts
    1 | 145 | src/agents/agent-hooks/compaction-safeguard.ts               <- big delta, ONE hunk
    1 |  50 | src/gateway/local-http-probe.test.ts
    1 |  42 | src/auto-reply/reply/groups.ts
    1 |  35 | packages/agent-core/src/harness/compaction/compaction.ts
    1 |  34 | src/cli/gateway-cli/run.ts
    1 |  32 | src/cli/plugins-cli-test-helpers.ts
    1 |  28 | src/tui/gateway-chat.test.ts
    1 |  27 | src/agents/embedded-agent-runner/run/assistant-failure.ts
    1 |  23 | src/tui/embedded-backend.test.ts
    1 |  16 | src/gateway/server-lifecycle.ts
    1 |  13 | src/agents/sessions/agent-session-compaction.ts
    1 |  13 | extensions/telegram/src/polling-session.ts
    1 |   9 | src/infra/heartbeat-runner.tool-response.test.ts
    1 |   6 | src/commands/doctor-config-flow.ts
    1 |   6 | src/agents/failover-policy.ts
    1 |   1 | src/infra/heartbeat-runner-execution.ts

One file with 6 hunks; everything else is 1-3. `compaction-safeguard.ts` looks alarming
at +145 but is a single hunk — a block insertion, not interleaved edits.

## The one relocation, and it is trap 3 in reverse

`src/agents/embedded-agent-runner/run/attempt-dispatch-preparation.ts` is absent at 9.3.
Upstream **inlined it back** into `run-loop.ts` — `prepareAndDispatchEmbeddedRunAttempt`
lives there now. Our +41/-2 must be re-anchored into the new home and the orphan dropped.
Not a product question: the capability moved, it was not retired.

## What moving to 9.3 costs us

The 5 commits unique to 9.2 are release scaffolding: release notes, release prep, and
two `fix(release)` commits touching only test files, a shell script, and dependency
version bumps from the security qualification. **No product logic is lost.** The
dependency bumps want re-checking against whatever 9.3 pins.

## Method, and the traps that already cost time on 8.1 -> 9.2

Read the trap list before starting. All five were paid for once already:

1. "Keep both sides" on an import collision -> duplicate-identifier PARSE ERROR.
2. Auto-merge keeps the fork's identifier inside upstream's renamed scope; only the
   typecheck catches it. Run all three lanes.
3. A fork-local EXTRACTION where upstream rewrote the original silently discards
   upstream's work.
4. Applying the fork's diff faithfully can land it on the WRONG HELPER — verify the
   PRODUCTION call site, not just that tests pass.
5. Upstream EXTRACTS and the carry keeps both copies -> duplicate test names.

Classify every failure with THREE cells, not two:

    alone on the branch | alone at the new tag | alone at the DEPLOYED sha

The third cell is what separates "we introduced this" from "we have always shipped
this". Without it, two-cell comparison overclaimed three times on 2026-09-09.

## Recommendation

9.3 is roughly half the carry we just finished, from a base that is now clean and fully
classified. It is a day of work, not a week. It is not urgent: both bots are healthy on
the 9.2 base and 9.3 is two days newer.

## Instrument note on the retracted figure

The first projection said 70 hand-resolutions and "many files 9.3 deleted", listing
`PORTING-NOTES.md`, `.qmdignore` and `memory-refresh.ts` among the deletions. That
script counted **fork-only files as deletions** — files absent at the 9.2 base because
WE created them. They have no delta to replay and simply copy over. 42 files were
scored as product decisions and every one was a non-event. Skip a file when it is
absent at the BASE.

---

# Carrying onto v2026.9.6 (9.5 -> 9.6), 2026-09-23

Branch `upgrade-v2026.9.6`, built from `upgrade-v2026.9.5` at `afc498ca1e7`
(the bots run `764e5007023`; `afc498ca1e7` adds only the bot-pair author rule and
a test-only mantis fix). Everything below was measured on this carry, not
carried forward from an earlier one.

## Topology

    v2026.9.5^{commit}          ec9c1a13db8
    v2026.9.6^{commit}          eb377ac59e6
    merge-base                  309e85fe12c   2026-09-17
    commits only in 9.6         2,792
    commits only in 9.5             4   release scaffolding + #151977
    9.5 -> 9.6                  17,431 files, +1,363,916 / -439,135

Sibling release branches again, so the same squash-and-cherry-pick as 9.4 and 9.5:

    SQUASH=$(git commit-tree <reduced-fork>^{tree} -p v2026.9.5^{commit})
    git cherry-pick -n $SQUASH        # onto v2026.9.6

The one 9.5-only product commit, `80ae94528f6` (#151977), is in 9.6 as
`a9fea70fcba` with the same patch-id, so moving to 9.6 loses nothing.

## Revert pass: upstream ports 9.6 already contains

Candidates were every `(#NNNNN)` in fork commit subjects across the 9.2, 9.3,
9.4 and 9.5 lines (16 numbers), plus every PR number named in their bodies
(34 more), matched against subjects in `309e85fe12c..v2026.9.6`.

| fork commit                                                                | PR                                      | 9.6 commit    | decision                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `17174e3a88a`                                                              | #151461 (sticker emoji)                 | `f3947b7f934` | **reverted**: identical patch-id, so a landing, not a revert. The revert left all three files byte-identical to the 9.5 tag, so the fork had no other delta in them |
| squashed across `7616f08043c`, `0314b464965`, `745a87c5623`, `764e5007023` | #141843 (untyped 5xx -> `server_error`) | `776f76b4b87` | **not revertable** (spread across three squashes); resolved to upstream's landed lines at conflict time, below                                                      |

The other 14 subject-matched PRs were already in 9.5 and were handled by the
9.5 carry. #144979 and #151924 (the `afc498ca1e7` pair) are NOT in 9.6: the
mantis test blobs are unchanged 9.5 -> 9.6 and `bot-pair-loop-facts.ts` is
fork-only.

    fork delta vs 9.5    352 files -> 349 after the revert
    conflicts            46 -> 46    (the #151461 files merged cleanly either way)

The 46 matched `git merge-tree --write-tree --merge-base v2026.9.5^{commit}`
exactly, before and after.

## #141843 landed upstream: what that means for the standing ruling

Alex's own PR landed in 9.6 as `776f76b4b87` (2026-09-19). The ruling "keep
untyped HTTP 500 -> `server_error`, not the timeout lane" is now upstream
behaviour, so the fork no longer diverges on it.

- Status mapping: upstream maps 499, 504, 522 and 524 to `timeout` and every
  other 5xx to `server_error`. That is the same set as the fork's
  `TIMING_HTTP_STATUSES` (408 is handled earlier by both). Took upstream's
  lines; the fork's `isTimingHttpStatus` helper is gone.
- CDN HTML path: upstream delegates to the shared status classifier. The one
  observable difference: an HTML **529** page is now `overloaded` (upstream)
  where the fork said `server_error`. Both are failover-worthy.
- Kept, fork-only: `server_error` in `shouldUseTransientCooldownProbeSlot`.
  Upstream's PR body says the cooldown-probe policy was left intact, so on
  upstream a reclassified 502 is no longer probe-eligible; on the fork it still
  is (deployed behaviour since 9.2).
- The 9.5 test pin in `result-fallback-classifier.test.ts` is now upstream's own
  test with the same expectation. The pin's divergence comment is obsolete and
  went with the conflict. The other 9.5 pin (compaction checkpoint handle in
  `session-manager-provenance-compaction.test.ts`) carried unchanged.

## Deleted-file decisions

- Files the fork MODIFIES that 9.6 deletes: **0** (297 of 297 present at 9.6;
  control: all 297 present at 9.5). The cherry-pick reported no renames and no
  modify/delete.
- Fork-added files that 9.6 also adds at the same path: **0**.
- One fork-added file deleted by me:
  `src/infra/heartbeat-runner.tool-response.previews.test.ts` (trap 5). It is
  the 8.1 max-lines split of upstream's UTF-16 preview test; the 9.5 carry
  restored upstream's copy in `heartbeat-runner.tool-response.test.ts` and
  left this one too. Two byte-identical tests; upstream's stays (941 lines,
  under the 1000 cap).
- Trap-5 sweep: 139 carry test files, 408 added test/describe names, 6 found
  in another file at 9.6. One real duplicate (above); the other five are
  generic describe names or a name the fork moved out of
  `auth-controller.test.ts` (0 copies left there, measured).

## Per-file rulings (46 conflicts: 40 hand, 6 generated)

Rule throughout: take 9.6's structure, then re-apply the FORK's delta where
9.6 moved the code.

| file                                                                                                                                                                                                                                                          | 9.6 change that collided                                                                                 | ruling                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/assertion-safety-baseline.txt` + 4 codex prompt snapshots                                                                                                                                                                                             | generated                                                                                                | took 9.6, regenerated                                                                                                                                                                                                      |
| `config/env-var-count-budget.txt`                                                                                                                                                                                                                             | 9.6 lowered 492 -> 491                                                                                   | 491 + the fork's one name = 492                                                                                                                                                                                            |
| `failover/classify-core.ts`, `classification-rules.ts`, `classify.test.ts`, `result-fallback-classifier.test.ts`, `assistant-failure.failover.test.ts`, `run-termination.test.ts`, `worker-turn-launcher-computer.test.ts`, `docs/concepts/model-failover.md` | #141843 landed                                                                                           | took 9.6 whole (see above)                                                                                                                                                                                                 |
| `failover-error.ts`                                                                                                                                                                                                                                           | 9.6 removed the casts (`asOptionalObjectRecord`)                                                         | the fork's delta was only 12 SAFETY comments on those casts -> 9.6                                                                                                                                                         |
| `run/helpers.ts`                                                                                                                                                                                                                                              | 9.6 moved the transient-retry helpers into `failover-retry-controller.ts`                                | kept only the fork's overload backoff policy here                                                                                                                                                                          |
| `run/failover-retry-controller.ts`                                                                                                                                                                                                                            | imports                                                                                                  | 9.6's diagnostics import + the fork's `computeBackoff`                                                                                                                                                                     |
| `run/incomplete-turn-recovery.ts`                                                                                                                                                                                                                             | 9.6 removed the cast                                                                                     | 9.6                                                                                                                                                                                                                        |
| `run/attempt-spawn-workspace.test-support.ts`                                                                                                                                                                                                                 | 9.6 extracted `SessionManagerMocks` into `...session-manager-mock.test-support.ts`                       | the fork's `setCompactionCheckpointHandleFormatter` field moved there                                                                                                                                                      |
| `auth-profiles/constants.ts`                                                                                                                                                                                                                                  | 9.6 rewrote the lock doc ("claiming and settling, not provider I/O")                                     | 9.6's doc + the fork's retries=22 note                                                                                                                                                                                     |
| `auth-profiles/oauth.ts`                                                                                                                                                                                                                                      | `OAuthManagerRefreshError` moved to `oauth-refresh-failure.js`                                           | union with the fork's `classifyOAuthRefreshFailureReason`                                                                                                                                                                  |
| `auth-profiles/store.ts`                                                                                                                                                                                                                                      | options type moved to `runtime-read.ts`; runtime loader moved into `createAuthProfileStoreRuntimeReader` | `skipInheritance` added in `runtime-read.ts`; the fork's `loadAgentLocalAuthProfileStore` kept                                                                                                                             |
| `auth-profiles/external-cli-sync.ts`, `oauth-refresh-failure.test.ts`                                                                                                                                                                                         | imports                                                                                                  | union                                                                                                                                                                                                                      |
| `sessions/agent-session-compaction.ts`                                                                                                                                                                                                                        | 9.6 computes `tokensAfter` inside the write                                                              | the fork's leaf-moved guard first, then 9.6's computation                                                                                                                                                                  |
| `sessions/session-manager-entries.ts`                                                                                                                                                                                                                         | new base class `SessionManagerSuffixPersistence`                                                         | 9.6's base + the fork's checkpoint formatter                                                                                                                                                                               |
| `tools/sessions-history-tool.ts` (+ test)                                                                                                                                                                                                                     | schema now derived from `ChatHistoryParamsSchema`                                                        | `compactionId` as `Type.With(ChatHistoryParamsSchema.properties.compactionId)`; `shadowedCount`/`returnedCount` kept                                                                                                       |
| `tool-description-presets.ts` (+ test)                                                                                                                                                                                                                        | new `sessions_history` wording                                                                           | 9.6's wording + the fork's compactionId sentence                                                                                                                                                                           |
| `sqlite-history-query.ts`, `session-transcript-readers.ts`, `chat-history-handler.ts`, `chat-send-agent-dispatch.ts`, `server-close.ts`, `status.scan.shared.test.ts`                                                                                         | imports                                                                                                  | union                                                                                                                                                                                                                      |
| `server-http.ts`                                                                                                                                                                                                                                              | `PluginHttpRequestHandler` moved to `server/plugins-http.js`                                             | the fork's healthz re-export kept                                                                                                                                                                                          |
| `server-start.ts`                                                                                                                                                                                                                                             | 9.6 dropped a test import                                                                                | the fork's `resetGatewayShuttingDownState`                                                                                                                                                                                 |
| `server-methods/health.ts`                                                                                                                                                                                                                                    | 9.6 no longer revives the cached event loop                                                              | destructure both `eventLoop` and `runtimeConfig`                                                                                                                                                                           |
| `infra/state-migrations.doctor.ts`                                                                                                                                                                                                                            | 9.6 extracted the owner helper into `state-migrations.legacy-owner.ts`                                   | the fork's `hasExplicitSessionStoreOwner` disjunct re-applied there                                                                                                                                                        |
| `cron/isolated-agent/run-executor.ts`                                                                                                                                                                                                                         | `CronCompletedPromptRun` moved to `run.types.ts`                                                         | `requestedProvider`/`requestedModel`/`usedFallback` added there; `run-finalize` still reads `usedFallback`                                                                                                                 |
| `server-methods/cron.validation.test.ts`                                                                                                                                                                                                                      | foreign/operator cases folded into a `describe.each`                                                     | kept only the fork's missing-id test                                                                                                                                                                                       |
| `media/store.ts`                                                                                                                                                                                                                                              | read-scope write path in `writeSavedMediaBuffer`                                                         | 9.6's path + the fork's inbound-save log                                                                                                                                                                                   |
| `channels/turn/lifecycle.ts`                                                                                                                                                                                                                                  | inline `deliver` extracted to `deliverReply()`                                                           | the fork's `durableTerminal` tag + SAFETY re-applied inside `deliverReply`; the helpers the fork moved to `delivery-visibility.ts` are byte-identical at 9.5 and 9.6, so that extraction hides nothing                     |
| `tools/message-tool-execution.ts`                                                                                                                                                                                                                             | 9.6 extracted `resolvePollVoteEchoRoute` into `poll-vote-echo.ts`                                        | trap 3 again, both directions: the fork's `send-suppression.ts` keeps the tracker state (test setup clears it), its resolver copy was deleted, and both guards now key on 9.6's resolver                                   |
| telegram `bot-handlers.message-pipeline.ts`                                                                                                                                                                                                                   | #151911: reply media moved into `hydrateMedia()`, external replies hydrate too                           | the fork's file_unique_id dedupe, own-bot skip and `fileUniqueId` re-applied on 9.6's loop; the chat scope is now a `hydrateMedia` parameter (chain: the node's chat/thread; external reply: the chat the turn arrived in) |

## Pre-existing fork defects found on the way (NOT fixed here; the deployed build has them too)

1. **The overload backoff has no production caller, and has not since 9.2.**
   `maybeBackoffBeforeOverloadFailover` (config
   `agents.defaults.embeddedAgent.overloadBackoffMaxMs`) is defined on the
   failover controller and called only by `failover-overload-backoff.test.ts`.
   Its 8.1 call sites (`assistant-failover.ts`, `prompt-failure.ts`,
   `attempt-recovery.ts`, `run-loop.ts`) are gone on `upgrade-v2026.9.2`,
   `.9.3`, `d99eb39b331` and `upgrade-v2026.9.5`. Trap 4 exactly: tests green,
   production inert. Re-wiring it changes bot behaviour, so it is Alex's call.
2. **`OAUTH_REFRESH_INLOCK_TIMEOUT_MS` is inert too.** At 9.5 it is referenced
   only by tests and a comment; no production code wraps anything in it. 9.6's
   own doc on the lock options now says the lock covers "claiming and settling
   OAuth generations, not provider I/O", so its premise (the network call runs
   inside the lock) no longer describes upstream either. Its only live effect is
   `retries: 22` in the lock options. Kept as-is.

## Typecheck fixes after the carry (commit `fix(v2026.9.6): make the carry typecheck...`)

9 errors, every one fork code meeting a 9.6 API change:

| file                                                     | 9.6 change                                                                                                                                      | fix                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `session-accessor.pending-inputs.ts`                     | the two-argument hash helper became a private `preparePendingInputMessage`; `preparePendingInputRequest` now needs a run id and idempotency key | export `preparePendingInputMessage` and call it, so the answered-turn marker and stage admission share one hash |
| telegram `bot-handlers.message-pipeline.ts` (2)          | `hydrateMedia` takes a media-only `Pick<Message>` with no chat or thread                                                                        | chat scope passed in as a parameter                                                                             |
| `status.scan.shared.test.ts` (2, fork tests)             | `gatewayProbeDeadlineMs` required                                                                                                               | `createStatusGatewayProbeBudget()`                                                                              |
| `tui-command-handlers.test.ts` (fork test)               | `createHarness` renamed `createTuiCommandHandlersHarness`                                                                                       | trap 2: a free variable, renamed                                                                                |
| `restart-recovery-claim.test.ts` (2, fork tests)         | claim controller requires `agentId`                                                                                                             | `agentId: "main"`                                                                                               |
| telegram `bot-message-context.reply-media-guard.test.ts` | `isTelegramMessageFromCurrentBot` moved to `message-cache-codec.ts`                                                                             | import from there                                                                                               |

Lint found one more carry-caused problem, and it is fixed: the fork's
answered-turn marker helper in `agent-run-execution-phase.ts` shadowed 9.6's
new outer `sessionKey` (`no-shadow`).

## Regenerated artifacts

- `plugins:assets:build`: the workboard control-ui hash in
  `extensions/workboard/openclaw.plugin.json` changes. Control: a clean 9.6
  worktree rebuilds exactly its committed hash (`e7af77ce...`), so the new hash
  (`78432061...`) comes from the carry, most likely the fork's gateway-protocol
  schema delta. `plugins:assets:check` passes after the commit.
- `prompt:snapshots:gen`: the 4 codex fixtures (the sessions_history tool's
  compactionId parameter and description).
- `protocol:gen`, `:swift`, `:kotlin`: no diff. The carried Swift models already
  carry `chat.history` `compactionId`.
- Assertion-safety baseline: pruned with `--base v2026.9.6^{commit}`, going from
  3727 to 3708 files and 10682 to 10607 assertions (20 lowered or removed).
  **One row was raised, and it is inherited:** `src/gateway/server-methods/send.ts`
  0 -> 1 (`request.action as never`). A clean 9.6 worktree fails its own ratchet
  on exactly that file, and `upstream/main` still has the line.
- **Guard base trap:** `check:assertion-safety` and `check:line-cap-ratchet`
  default to `merge-base HEAD origin/main`. In this repo `origin` is the writhub
  mirror, whose `main` is July's `fcdb9321b8a`, so the default base compares
  against a months-old tree. Use `--base v2026.9.6^{commit}` for a carry.

## Validation (2026-09-23, on this Air, node v24.18.0, pnpm 12.4.0)

| check                                                                                | result                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsgo:core`                                                                          | rc=0, 0 errors                                                                                                                                                                                                                                                                                                                    |
| `tsgo:extensions`                                                                    | rc=0, 0 errors                                                                                                                                                                                                                                                                                                                    |
| `check:test-types` (25 core test shards, extensions test, root test)                 | rc=0, 0 errors; all 25 shards reported passed                                                                                                                                                                                                                                                                                     |
| every core test shard ALONE, before the fixes                                        | 23 of 25 green; `commands` (3) and `messaging` (2) red, both fixed                                                                                                                                                                                                                                                                |
| `check:assertion-safety`, `check:max-lines-ratchet`, `check:env-var-count` (492/492) | rc=0                                                                                                                                                                                                                                                                                                                              |
| 31 other cheap guards from `scripts/check.mts` and `package.json`                    | rc=0                                                                                                                                                                                                                                                                                                                              |
| `plugins:assets:check`, `prompt:snapshots:check`, `protocol:check:swift`             | rc=0                                                                                                                                                                                                                                                                                                                              |
| `check:line-cap-ratchet --base v2026.9.6^{commit}`                                   | rc=1, **48** over-cap files grown by the fork. PRE-EXISTING class: the deployed line (`afc498ca1e7` against v2026.9.5) fails the same check with **50**. New in the carry: `src/commands/health.test.ts` (1026) and `src/media/store.ts` (715), both because 9.6 grew files the fork had already grown. Not split here (issue #9) |
| oxlint over the 318 carried TS files                                                 | 14 errors, the **same 14** that 9.6's oxlint 1.82.0 reports on the deployed-line tree (`afc498ca1e7`, its own deps). None is carry-caused                                                                                                                                                                                         |
| `oxfmt --check` over the 338 carried files                                           | clean                                                                                                                                                                                                                                                                                                                             |

Not run here: the test suite (the verifier lane's job). The trap-5 sweep and
the conflict-marker scan both ran and are recorded above.

## Pull-forwards onto the 9.6 carry (2026-09-24)

Nine of Alex's PRs pulled forward at their current heads, replacing the fork's
older variant of each where the fork carried one. The list and heads come from
the PR census (`oc96/pr-census.md`); every head was re-verified against its
scratch ref. Each PR was applied as its own diff, `git diff <merge-base with
upstream main>..<head>`, never as a merge of its branch, because the branches
sit on upstream `main` and the carry sits on the 9.6 release tag. One commit
per PR.

| PR      | head          | fork variant replaced                                                                                   | apply result                                                                                                                                                      | tests ALONE on the branch                                                                                                                                                                                       |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #151921 | `55ecc3210f4` | earlier dedupe (a prefix plus a punctuation-only tail was always a duplicate)                           | clean after resetting `messaging-dedupe.ts` and its test to 9.6                                                                                                   | sanitize 124/124, lifecycle 26/26, transport-dedupe 9/9, fork `message-tool.test.ts` 286/286, `qa-channel-message-tool-delivery` 23/23                                                                          |
| #156537 | `f5b7646141b` | none (new)                                                                                              | clean                                                                                                                                                             | heartbeat-events-filter 58/58, heartbeat-runner.tool-response 37/37                                                                                                                                             |
| #155000 | `325aa9423db` | none (new; the fork's silent-stop nudge in `terminal-resolution.ts` is untouched)                       | clean                                                                                                                                                             | subagent-reasoning-only 2/2                                                                                                                                                                                     |
| #151099 | `6b2305349c3` | pre-review inline carrier body in `inbound-meta.ts` plus 94 test lines                                  | clean after resetting `inbound-meta.ts` and its test to 9.6                                                                                                       | current-message 6/6, inbound-meta 78/78                                                                                                                                                                         |
| #101866 | `039c25673c7` | 114-line `transcript-grounding.ts` (`redactUngroundedMediaRefs`) and its test                           | clean after deleting the fork's two files and resetting `transcript.ts`                                                                                           | 7 files, 183/183                                                                                                                                                                                                |
| #138416 | `8f9fdab74af` | #723 window-scaled budget, dropped entirely (see below)                                                 | rebuilt from the PR head blob plus the fork's #721, #722 and SAFETY deltas; quality module merged with 0 conflicts                                                | summary-budget 3/3, safeguard-budget 1/1, fork #721 tests 3/3 and 6/6                                                                                                                                           |
| #130393 | `22caaf374fe` | the fork's #722 degrade path                                                                            | one conflict with #138416 at the `fitCompactionSummary` call site, resolved together; 2 test conflicts resolved to the PR                                         | tool-failures 8/8, safeguard 147/147, compact.hooks 196/196, degraded-reload 2/2, provider-boundary 5/5, session-compaction 18/18, fork degrade-fallback 6/6, agent-core compaction 48/48 and tool-pair-cut 2/2 |
| #151923 | `d7b158e8aa2` | `media-upload-size.ts`, the 3660 s client backstop and undici headersTimeout (96fcdcbb4eb, d99eb39b331) | clean after reverting the variant; the known add/add in `request-timeouts.test.ts` resolved as 9.6's tests plus the PR's                                          | request-timeouts 20/20, upload-real-transport 1/1, upload-timeout 4/4; 3 files re-anchored (below)                                                                                                              |
| #89526  | `5d5ad44f5f6` | pre-gate drift health (4 fork-only files, 9 files of fork edits)                                        | one conflict, the known mechanical one in `config-reload.ts`: take the PR's removal of `resolveChokidarUsePolling`, keep 9.6's local `GatewayConfigReloader` type | 12 files, 858/858 after the re-anchor below                                                                                                                                                                     |

Commits: `cf9c279edb1` #151921, `df63314bb9c` #156537, `d1bb7d61de0` #155000,
`f759ee4e478` #151099, `ba32a64e429` #101866, `0a0518c396d` #138416,
`c59c7cb9f56` #130393, `b6a4c2cb003` #151923, `93ad0681e24` #89526, then
`3818db5405b` (the #57137 hyphen fix), `94a5ae017c4` (workboard hash regen) and
`e8ad42c32ea` (test re-anchors).

### What each replacement changes against the deployed fork

- **#151921:** a prior send that prefixes the new text with a punctuation-only
  tail now falls through to the length ratio instead of always counting as a
  duplicate. A tail with any letter or digit is still delivered.
- **#151099:** the CLI inline prompt no longer repeats the Telegram body. It is
  stated in the carrier only.
- **#138416 (drops #723):** the safeguard audits what the owner will actually
  store, the 16,000-char persistence cap. The fork's scaled budget let the audit
  pass a 60,305-char summary that was then cut to 16,000, losing the Pending
  user asks and Exact identifiers sections (the PR's own 81514de9e81 message).
  Removed: `resolveCompactionSummaryBudgetChars`, `SUMMARIZER_*`, the scaled
  split-turn and preserved-turn caps, `fitCompactionSummary`'s `maxSummaryChars`
  parameter in agent-core, and the #723 tests. Kept: #721's feedback block
  (sized per the fork's #138415 variant, which the census says to keep) and the
  fork's I1 open-tool-call cut guard.
- **#130393:** the degrade now also covers infeasible required facts. It sheds
  the longest identifiers before dropping the request context, and reserves the
  generated split-turn summary at the head of the suffix. Fork test code it
  supersedes was removed: the FORK DIVERGENCE reconciliations in
  `agent-session-compaction.test.ts` and `compact.hooks.test.ts`, and a
  byte-identical duplicate test in `compaction-safeguard.test.ts` (trap 5).
- **#151923:** request guards scale with the upload's byte size, and grammY's
  client timer is 1,860 s (30 min + 60 s) rather than the fork's 3,660 s.
- **#89526:** `runtimeConfig` health is sent only to clients that advertise
  `RUNTIME_CONFIG_HEALTH`. The fork variant sent it to every client, with
  fingerprints gated by admin scope. Kept from the fork in `config-reload.ts`:
  the hybrid-mode restart warning (a #89517 remnant, not part of #89526).

### #130393's red CI test, measured here

`src/agents/sessions/agent-session-compaction.degraded-reload.test.ts` failed on
upstream CI in `checks-node-compact-large-44` with "Agent database resources are
closing". ALONE on this branch it passed **5 of 5 runs, 2/2 tests each**, routed
to the `infra` project, and no log contains that string. This is not a verdict
on the CI failure: that ran in a large shard, and its conditions were not
reproduced here. It says the test and its code are sound in isolation on this
tree.

### Re-anchors the ALONE runs found (`e8ad42c32ea`)

- Three 9.6 telegram test files pinned the pre-#151923 client timeout
  (`undefined`): `bot.create-telegram-bot.test.ts` (3 failed), `send.proxy.test.ts`
  (4 failed) and `send.test.ts` (1 failed). The PR never touched them because its
  `main` base had deleted those cases (#155040). They are pinned to 1860 now, the
  same eight expectations the fork's old variant pinned to 3660.
- `config-reload.test.ts` "honors model runtime restart write intent in hot mode"
  (a fork test from the pre-gate #89526 lineage) failed 1 of 486. #89526's head
  carries the same scenario in `config-reload.observation.test.ts`, which awaits
  9.6's async `reloader.ready`, and that version passes. Three cells: pass ALONE
  at the deployed-line `afc498ca1e7` (567/567), fail ALONE at the pre-pull carry
  `3b8d947de6b`, absent at the tag. So it was already a 9.6-carry defect,
  surfaced here, and the fork copy is removed.

### Greptile P1 on the fork's #57137 carry, fixed (`3818db5405b`)

`syncEnvBackedTokenCredentials` replaced only `:` and `.`, so a hyphenated
profile id looked up an env name no shell can export. Every character outside
`[A-Z0-9_]` now maps to `_`. The old name is still read when the portable one is
unset (a launchd plist can carry a hyphen), and the portable name wins when both
are set. Tests: 13/13. Reverting the regex reds exactly the two new cases.

### Held for Alex, left exactly as the carry had them

- #93952: the auth deadline backstop.
- #155273, together with the self-authored reply-media guard (#57280, #66912).
- #111913 / #52030 / #84972: Anthropic long-context routing.
- Fork PR #8.
- The dead `overloadBackoffMaxMs` wiring.
- #151924 was NOT pulled by its head, which is now a copy of #93952; the fork's
  own bot-loop wiring stays.

### Superseded rulings earlier in this section

Several 9.6 carry rows above describe fork variants as they stood on
2026-09-23, before the pull-forwards replaced them:

- `server-methods/health.ts` ("destructure both `eventLoop` and `runtimeConfig`");
- the compaction-safeguard #722 variant;
- the telegram upload-guard files;
- `inbound-meta.ts`.

For those files, the table above describes the current tree, not the earlier
rows.

## Alex's rulings of 2026-09-24, and the parallel carry

### #155273 pulled forward, and the self-authored reply-media guard dropped (`74dcb7a3910`)

Ruling: take #155273 at `0e1bce35c2d` and drop the fork's self-authored
reply-media guard, because prior generated media is load-bearing context. It was
applied as `diff(0ba669ef0bc..0e1bce35c2d)`. The whole #57280 re-derive
(b78d8c253c4 lineage) went with the guard:

- the `isTelegramMessageFromCurrentBot` skip in `resolveReplyMediaForChain`;
- the staged-path double-attach dedupe ("part b"): `mediaPathKeys` in the
  pipeline and `duplicateMediaFact` in `bot-message-context.session.ts`. Source
  identity (`file_unique_id`) now owns duplicate suppression. Part b also dropped
  any reply-chain media fact without a staged path, which is exactly the
  prior-media context the ruling keeps;
- `bot-message-context.reply-media-guard.test.ts`, and the fork's inverted
  `bot.test.ts` expectations, which are back to 9.6's.

Kept, unrelated to the PR: chat-scope stamping of inbound media (now a
`hydrateMedia` parameter) and the replied-before-failing replay guard.

Tests ALONE on the branch: reply-source-identity e2e 4/4, `bot.test.ts` 137/137,
and 12 other telegram media and album files green. Three reds, none caused by the
pull:

| test                                                                                                                | on the branch                       | control                                                    | verdict                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot.media.downloads-media-file-path-no-file-download.e2e` "uses custom apiRoot for buffered media-group downloads" | 1 failed                            | fails ALONE at the bare 9.6 tag                            | inherited                                                                                                                                                                                                     |
| `bot.media.warning-topics.e2e` "accounts for N failed attachments in an album"                                      | 1-2 failed                          | bare tag: pass, then fail (2 runs); carry: pass, then fail | inherited flake                                                                                                                                                                                               |
| fork `bot-handlers.message-pipeline.replay-guard.test.ts`                                                           | 1 failed, before and after the pull | 2/2 at the deployed `afc498ca1e7`                          | 9.6-carry defect: the test opens the plugin state DB, and 9.6 requires the host broker. Routed to `extension-database-workers` beside upstream's `message-dispatch-dedupe.test.ts` (`6d922fcd250`); 2/2 after |

### The held items: today's bot behaviour kept exactly

The coordinator relayed Alex's ruling, and it was checked against the tree
rather than assumed:

| item                      | kept as                                                                                       | evidence                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #93952 auth deadline      | the fork's 360 s `withRuntimeAuthRefreshDeadline` on every auth step, not #93952's 700 s head | `runtime-auth-refresh.ts` byte-identical to `afc498ca1e7`; `auth-controller.ts` wiring unchanged; runtime-auth-refresh 7/7, refresh-deadline 4/4, oauth-manager 20/20 |
| #111913 / #52030 / #84972 | the fork's long-context compact-and-retry                                                     | `context-overflow.ts` byte-identical to `afc498ca1e7`; overflow-context-recovery 45/45, context-overflow 14/14, classify.predicates 42/42                             |
| fork PR #8                | left out                                                                                      | `createSubagentTaskReconciler` and `TasksMaintenanceParamsSchema`: 0 hits on the branch, as at `afc498ca1e7`                                                          |
| `overloadBackoffMaxMs`    | left inert                                                                                    | `maybeBackoffBeforeOverloadFailover` has no production caller, the same as at `afc498ca1e7`; its unit test passes 6/6                                                 |

### Follow-ups

1. **Fork PR #8 (native orphan reconciliation fence).** It was never carried: its
   base is 8.1, it has 13 commits over 50 files, and it adds a `tasks.maintenance`
   gateway method. It needs re-deriving onto 9.6, whose orphan reconciliation was
   reordered upstream in 9.5. Blocked on Alex choosing to take it.
2. **The dead overload backoff.** The `agents.defaults.embeddedAgent.overloadBackoffMaxMs`
   config key is accepted and `maybeBackoffBeforeOverloadFailover` exists, but no
   production path calls it. Its 8.1 call sites (`assistant-failover.ts`,
   `prompt-failure.ts`, `attempt-recovery.ts`, `run-loop.ts`) disappeared in the
   8.1 -> 9.2 carry. The options are to re-wire it into 9.6's failover path or
   delete the key and the controller method. Either one changes what the bots do,
   so it is Alex's call.

### The parallel carry on mac-mini (`73e2cea0429`), file by file

mac-mini built its own `upgrade-v2026.9.6` (`0ed005fd170` carry +
`73e2cea0429` assertion-safety), never pushed. Its objects were already in the
repo and nothing was fetched from the host. Ruling: this branch is canonical, and
we adopt whatever the other carry resolved better. Against this branch's carry
commit `132e8e5c19d` it differs in 30 files. Each was decided on the 9.6 tag's
code, the fork delta's intent (the 9.5 branch and this ledger), and tests run
ALONE where they could discriminate.

| file                                                                                                                                                                                                | verdict                            | reason                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/assertion-safety-baseline.txt`                                                                                                                                                              | merged                             | took their removal of the `send.ts` row (via the adopted annotation); kept our `lifecycle.ts` annotation, which is the only reason their file has a `lifecycle.ts` row                                                                                    |
| `config/env-var-count-budget.txt`                                                                                                                                                                   | ours                               | same 492; ours states 491 + the fork's one name, measured 492/492, and keeps the trailing newline theirs lacks                                                                                                                                            |
| `extensions/telegram/src/bot-handlers.message-pipeline.ts`                                                                                                                                          | ours, then superseded by #155273   | theirs dropped chat-scope stamping in `hydrateMedia` and `fileUniqueId` on hydrated refs, so hydrated reply media never entered the dedupe set                                                                                                            |
| `extensions/telegram/src/bot-pair-loop-facts.ts`                                                                                                                                                    | ours                               | theirs lacks `afc498ca1e7` (the author rule), which must stay                                                                                                                                                                                             |
| `extensions/telegram/src/bot-pair-loop-facts.test.ts`                                                                                                                                               | ours                               | same; 8/8 ALONE                                                                                                                                                                                                                                           |
| `src/agents/auth-profiles/constants.ts`                                                                                                                                                             | ours                               | theirs restores 9.5's doc comments, which 9.6 rewrote because the lock no longer covers provider I/O; the values are identical                                                                                                                            |
| `src/agents/auth-profiles/oauth-refresh-failure.test.ts`                                                                                                                                            | ours                               | import order only                                                                                                                                                                                                                                         |
| `src/agents/auth-profiles/oauth.ts`                                                                                                                                                                 | ours                               | import order only                                                                                                                                                                                                                                         |
| `src/agents/auth-profiles/store.ts`                                                                                                                                                                 | ours                               | the same hoisted function in a different position; no behaviour difference                                                                                                                                                                                |
| `src/agents/failover/classification-rules.ts`                                                                                                                                                       | ours                               | theirs keeps the fork's `isTimingHttpStatus`; the status set is identical, and ours is upstream's landed #141843 byte for byte, so the next rebase is a no-op                                                                                             |
| `src/agents/tools/message-tool-execution.send-suppression.ts`                                                                                                                                       | ours                               | theirs keeps a second copy of `resolvePollVoteEchoRoute` beside 9.6's owner in `poll-vote-echo.ts` (trap 3); ours has one owner                                                                                                                           |
| `src/agents/tools/message-tool-execution.ts`                                                                                                                                                        | ours                               | follows from the row above (which module the resolver is imported from)                                                                                                                                                                                   |
| `src/agents/tools/sessions-history-tool.ts`                                                                                                                                                         | ours                               | keeps the model-facing `compactionId` description the bots run today (present at `afc498ca1e7`); theirs drops it, because the protocol schema carries none                                                                                                |
| `src/channels/turn/lifecycle.ts`                                                                                                                                                                    | ours                               | keeps the SAFETY annotation on the routed-turn cast; theirs drops it and grandfathers the cast instead                                                                                                                                                    |
| `src/config/sessions/session-accessor.pending-input-request.ts`                                                                                                                                     | converged                          | the same export of `preparePendingInputMessage` as our `0d74a187fd0`; ours adds a doc line                                                                                                                                                                |
| `src/config/sessions/session-accessor.pending-inputs.ts`                                                                                                                                            | converged                          | byte-identical to this branch's head                                                                                                                                                                                                                      |
| `src/gateway/server-close.ts`                                                                                                                                                                       | ours                               | keeps the comment explaining the shutdown-state extraction; the code is identical                                                                                                                                                                         |
| `src/gateway/server-http.ts`                                                                                                                                                                        | ours                               | one blank line                                                                                                                                                                                                                                            |
| `src/gateway/server-methods/cron.validation.test.ts`                                                                                                                                                | ours                               | theirs re-adds two tests that 9.6 folded into its `describe.each` table (trap 5 duplicates)                                                                                                                                                               |
| `src/gateway/server-methods/send.ts`                                                                                                                                                                | **theirs adopted** (`c476d3d7866`) | annotates the tag's own unannotated `request.action as never` instead of grandfathering it; the invariant was verified against this tree; send.test 135/135                                                                                               |
| `src/gateway/worker-environments/worker-turn-launcher-computer.test.ts`                                                                                                                             | ours                               | theirs keeps a FORK DIVERGENCE comment that is false at 9.6 (#141843 landed); the assertion is identical                                                                                                                                                  |
| `src/infra/heartbeat-runner.tool-response.previews.test.ts`                                                                                                                                         | ours (deleted)                     | a byte-identical duplicate of 9.6's test (trap 5)                                                                                                                                                                                                         |
| `src/infra/state-migrations.legacy-owner.ts`                                                                                                                                                        | ours                               | theirs loses the fork's `hasExplicitSessionStoreOwner` disjunct (the live-defect fix in "Corrections found during the carry"). With their file, "migrates the legacy session store for an explicit fixed-store owner" fails (123/124); with ours, 124/124 |
| `src/media/store.ts`                                                                                                                                                                                | ours                               | theirs drops the inbound-save log on the buffer path (fork 56cb4a3b826, the wrong-chat attachment incident). No test covers the line (71/71 either way), so this rests on that commit's stated contract                                                   |
| 4 codex prompt snapshots (`codex-dynamic-tools.telegram-direct.json`, `discord-group-codex-message-tool.md.diff`, `telegram-direct-codex-message-tool.md`, `telegram-heartbeat-codex-tool.md.diff`) | ours                               | generated; they differ only through the `sessions-history-tool.ts` description row; `prompt:snapshots:check` passes on ours                                                                                                                               |
| `test/scripts/mantis-telegram-failure.test.ts`, `test/scripts/mantis-telegram-proof.test.ts`                                                                                                        | ours                               | theirs lacks #144979 from `afc498ca1e7`, which must stay                                                                                                                                                                                                  |

Result: one adoption (`send.ts`), one merge (the baseline), two converged files,
and 26 files where ours is kept.
