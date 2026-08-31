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
- **Direct `oxlint` over `src`: 11 errors, of which 6 are pre-existing at the
  tag.** The pristine tag reports those same 6 (`no-control-regex` ×1,
  `preserve-caught-error` ×5), so plain `oxlint src` is not a clean gate even
  upstream. The carry introduced 14; 8 are fixed, and the remainder are
  `max-lines` files being split.

### `npm run lint` cannot be run on this machine

It fails before oxlint ever executes:

    Error: plugin-sdk boundary dts timed out after 300000ms
      at prepare-extension-package-boundary-artifacts.mts:142

The prerequisite dts step exceeds its own 300 s ceiling here, and the failure
leaves an orphaned `.artifacts/dist-artifacts.lock` directory that blocks the
next run until removed. **Direct `npx oxlint --config .oxlintrc.json <paths>`
is the valid local instrument**; the wrapper's verdict is unavailable.

Likewise for tests: `npx vitest run <path>` boots every project config and gets
killed on long runs. The repo's own runner is
`node scripts/run-vitest.mjs run --config test/vitest/vitest.<project>.config.ts <path>`.

Note the wrapper reports `[exited with code 0]` in some harnesses even when the
inner step timed out — that line is the runner's, not the gate's. Read the
body, not the exit line.

## Measurement traps hit during this port

Kept because each cost a wrong answer.

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

## Not established

- **No full test-suite run.** Individual files were run; the suite as a whole
  has not been, and several lanes reported that their carried files had never
  been executed at all.
- **No typecheck and no build.** Import resolution was checked structurally
  (993 relative named imports resolved, with positive and negative controls),
  which proves symbols _exist_, not that types are compatible. Bare-specifier
  imports (`@openclaw/*`, `vitest`, `node:*`) were not checked at all.
- **SAFETY invariants on inherited assertions are readings, not proofs.** The
  ratchet counts comments; it never validates the claim. They assert properties
  of code the annotator did not author.
- **The `fallbackBaseUrl` embedding failover is the highest-risk carry.** It
  merged cleanly with correct symbols, but its timeout-splitting and cooldown
  semantics are untested here. `embeddings.failover.test.ts` is the instrument.
- **`compaction-safeguard.ts` heartbeat/`isHeartbeatPrompt` re-anchor.** One
  proposed re-anchor was proven _wrong_ and reverted; the correct one was not
  established, so beta.3's heartbeat test remains unsatisfied.
- **Deployment.** Both hosts still run `2026.8.1-beta.3 (77549fa)`. Nothing
  from this branch has been deployed.
