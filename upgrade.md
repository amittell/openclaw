# OpenClaw upgrade plan — target `v2026.4.9`

## Goal

Prepare a **repeatable, low-drama** upgrade from the currently deployed custom OpenClaw build (workspace memory says `2026.3.13`) to **`v2026.4.9`**, with:

1. a written upgrade plan,
2. a replay script for the low-risk carries,
3. exported patch/diff artifacts for every known non-upstream carry,
4. an explicit manual reconcile queue for the risky/conflicting carries,
5. enough prep that the next step can be a single **"go"** to execute the upgrade.

This branch is **prep only**. It does **not** perform the live upgrade.

---

## Sources checked

Primary references used for this prep:

- Upstream tag: `v2026.4.9`
- Prior prep branches:
  - `origin/upgrade/2026-03-31`
  - `origin/upgrade/2026-04-02`
- Alex PR inventory against `openclaw/openclaw` (open + closed)
- Previous carry script reference:
  - `scripts/carry-upgrade-2026-03-31.sh` from commit `8a2e184e87b0`
- Disposable replay probes against `v2026.4.9` to classify carries as:
  - clean cherry-pick,
  - manual reconcile,
  - conditional / re-audit only.

---

## Planned branch / execution model

- **Prep branch:** `upgrade/v2026.4.9`
- **Base tag:** `v2026.4.9`
- **Replay helper:** `scripts/carry-upgrade-v2026.4.9.sh`
- **Distpatch exporter:** `scripts/export-distpatches-v2026.4.9.sh`
- **Generated carry artifacts:** `distpatches/v2026.4.9/`

Recommended live execution model when you say **go**:

1. fresh worktree from `v2026.4.9`
2. run replay script for the safe batch
3. apply the manual queue in the order below
4. run build + targeted tests after each risky family
5. only then swap the installed runtime/build

---

## High-risk upgrade-sensitive upstream changes (from `2026.3.13` → `2026.4.9`)

These are the **breaking / operationally significant deltas** I would treat as real upgrade risks for this environment.

### 1) Telegram internals moved and were repackaged

Why it matters:

- Several old Telegram fixes now land in **different files/paths** than the `2026.3.13` era.
- Example: old `src/telegram/monitor.ts` logic is now under `extensions/telegram/src/monitor.ts`.
- Old reply-media handler surfaces changed; some prior files no longer exist.

Operational impact:

- PR `#39205` and `#57280` cannot be replayed blindly.
- Telegram carries must be ported onto the **current extension layout**, not old core paths.

### 2) Packaged/plugin sidecar loading changed substantially

Relevant upstream items include:

- packaged Telegram setup sidecars
- packaged bundled-channel sidecars
- packaged plugin compatibility metadata alignment
- plugin facade/circular-load fixes
- npm packaging root mirror fixes

Why it matters:

- Any carry that assumes old `dist/extensions/.../src/...` import paths is fragile.
- Upgrade scripts need to validate packaged runtime loading, not just source-tree behavior.

### 3) Memory/LanceDB runtime resolution changed upstream

Relevant upstream item:

- `Memory/LanceDB`: resolve runtime dependency manifest lookup from bundled `extensions/memory-lancedb` path so startup no longer fails with missing `@lancedb/lancedb` dependency errors.

Why it matters:

- This is directly related to the recurring “LanceDB breaks after upgrade” failure mode.
- The upstream fix helps, but I still want the live upgrade to verify:
  - plugin config parse compatibility,
  - runtime dependency install/resolve path,
  - actual writable runtime directory,
  - memory tool registration after restart.

### 4) Memory host/session indexing paths changed

Why it matters:

- Older memory carries touched `src/memory/session-files.ts`.
- Current target uses `packages/memory-host-sdk/src/host/session-files.ts`.
- Any memory index carry (`#49220`, `#43498`) must be ported onto the **new host SDK path**.

### 5) Auth-profile internals changed shape

Why it matters:

- `auth-profiles` is more modular now (`profiles.ts`, `store.ts`, `doctor.ts`, etc.).
- `#49429` (`models auth clean`) conflicts directly in the new modular auth code.
- Live replay must not leak profiles across agent scopes or regress auth-store locking.

### 6) ACP / reply dispatch internals changed

Why it matters:

- `#49420` still matters, but replay must land on current ACP control-plane code.
- The risky files are now:
  - `src/auto-reply/reply/dispatch-acp.ts`
  - `src/acp/control-plane/manager.core.ts`
  - `src/acp/control-plane/manager.identity-reconcile.ts`

### 7) Gateway restart / macOS launchd behavior changed upstream

Why it matters:

- Upstream now has several macOS restart / LaunchAgent recovery fixes.
- Good news: fewer local patches should be needed here.
- Bad news: any local restart assumptions from older upgrade scripts may now be stale.

### 8) Config alias cleanup / migration behavior changed

Relevant upstream item:

- removal of legacy public config aliases in favor of canonical paths, with `doctor --fix` migration support.

Why it matters:

- The live upgrade must include a config validation pass before restart.
- This is especially important for plugin-owned config surfaces and memory-lancedb config.

### 9) Exec defaults / approval routing changed upstream

Why it matters:

- Host exec defaults and approval behavior moved several times.
- Not a blocker for the gateway itself, but it affects post-upgrade confidence tests and long-running task behavior.

### 10) Explicit upstream migration / compatibility changes to verify in the live config

These are the upgrade-sensitive upstream changes I found that can break an install even when the code itself builds.

| Upstream change | Why to verify on this install |
|---|---|
| Legacy config aliases removed in favor of canonical public paths (with `doctor --fix` migration support) | Any stale alias in the real config can fail validation or behave differently after upgrade |
| `x_search` config moved to `plugins.entries.xai.config.*` | Only relevant if X search is configured, but worth checking before restart |
| Firecrawl `web_fetch` config moved to plugin-owned `plugins.entries.firecrawl.config.*` | Same story: harmless if unused, disruptive if configured on old paths |
| `gateway.mode` now defaults to `local` when unset | Good upstream change, but worth verifying there is no unexpected mode drift |
| Telegram setup/contracts now load from packaged sidecars instead of old `dist/extensions/.../src/...` imports | Directly relevant because this install depends on Telegram |
| Bundled plugin/channel compatibility metadata is now tied to the release version | Packaging mistakes show up here as bundled plugin load failures |
| LanceDB runtime manifest lookup now resolves from the bundled extension path | Directly relevant to the recurring LanceDB breakage after upgrades |
| macOS gateway restart / LaunchAgent recovery behavior changed upstream | Relevant because this install runs as a macOS LaunchAgent |

---

## Carry inventory

### A. Safe replay batch — validated clean on top of `v2026.4.9`

These were replay-probed in a disposable worktree and applied cleanly as-is.

| Status | PR / source | Commit | What it does | Notes |
|---|---:|---|---|---|
| clean | `#52030` | `59d2d5aa6818` | Treat Anthropic long-context usage errors as context overflow for compact+retry | Safe single-commit carry |
| clean | `#56532` | `871a86eed717` | Add configurable timeout + retry limits for memory-lancedb embeddings | Safe single-commit carry |
| clean | `#56536` | `d4882f6b42cf` | Show full IDs in `memory_forget` candidate list | Use the functional commit, **not** the generated-baseline follow-up |
| clean | `#57137` | `17a97e50d553` | Sync env-var-backed token credentials into auth store | Safe auth-only carry |
| clean (local) | local carry | `7d0f609e0b` | Strip `[media attached: ...]` annotations from recalled memories before prompt escaping | Low-risk local carry |
| clean (local) | local carry | `b172f7987c` | Give Telegram `getUpdates` long-poll headroom | Low-risk operational Telegram carry |

### B. Manual reconcile queue — replay probe hit conflicts or overlaps

These should **not** be auto-replayed blindly.

| Status | PR / source | Why manual | Main hotspots on `v2026.4.9` |
|---|---:|---|---|
| manual | `#57280` | old reply-media handler path moved / deleted | `extensions/telegram/src/bot-handlers.runtime.ts` and current reply-media flow; old `bot-handlers.buffers.ts` no longer maps cleanly |
| manual | `#56166` | direct conflict in orphan reconciliation helper | `src/agents/subagent-registry-helpers.ts` |
| manual | `#56529` | runner logic drifted | `src/agents/pi-embedded-runner/run.ts` + config schema/help/labels/types |
| manual | `#56537` | cron/runtime model plumbing drifted | `src/cron/isolated-agent/run.ts`, `src/agents/command/session-store.ts` |
| manual | `#49429` | auth internals refactored | `src/agents/auth-profiles/{profiles,store}.ts`, `src/commands/models/auth-clean.ts`, CLI wiring |
| manual | `#49431` | gateway startup + pending-inbound surfaces drifted | `src/gateway/server-startup.ts`, `src/infra/pending-inbound-store.ts`, `src/infra/system-events.ts`, command queue |
| manual | `#49420` | ACP control-plane drift | `src/auto-reply/reply/dispatch-acp.ts`, ACP manager files |
| manual | `#49391` | overlaps Telegram empty-text/retry family | Telegram delivery/reply-threading + outbound deliver guard |
| manual | `#49220` | memory host session indexing path changed | `packages/memory-host-sdk/src/host/session-files.ts`, `src/utils/directive-tags.ts` |
| manual | `#43498` | multi-file memory/index carry with later review fixes | `extensions/memory-lancedb/index.ts`, `packages/memory-host-sdk/src/host/session-files.ts` |
| manual | `#43497` | base commit is clean, but full reviewed PR has many follow-ups | `src/agents/subagent-{resume,registry,spawn}.ts` + types |
| manual | `#39205` | Telegram monitor path moved from old core path | `extensions/telegram/src/monitor.ts` |
| manual (local) | local carry `29a6e46a82` | memory-lancedb graceful-degradation patch conflicts | `extensions/memory-lancedb/index.ts` |
| manual / conditional | local carry `9846d8588c` | clean replay, but overlaps `#49391` / `#42485` family | Telegram delivery + send + threading surfaces |
| manual / conditional | `#42485` | one isolated retry hunk replays cleanly, but the full family overlaps empty-text carries | Telegram network error / send retry surfaces |

### C. 4.2-era compatibility carries that should be **re-audited, not blindly replayed**

These showed up on the old prep branches, but they smell like **version-bridge fixes** rather than must-carry forever patches.

| Source | Commit | Why not auto-carry |
|---|---|---|
| local | `969fb098fb` | UI/browser import fix conflicts in `src/version.ts`; likely version-specific |
| local | `6d7af32cee` | "drop forward-only validators not in 4.2 types" is explicitly 4.2-era compatibility work |
| local | `8db3877d5f` | deferred AJV compilation fix conflicts in multiple plugin/gateway metadata files; re-check only if the packaged build still reproduces stack overflow |

---

## Distpatch strategy

### Files prepared in this branch

- `scripts/carry-upgrade-v2026.4.9.sh`
- `scripts/export-distpatches-v2026.4.9.sh`
- generated carry artifacts under `distpatches/v2026.4.9/`

### Artifact policy

The distpatch folder should contain:

1. `clean/` — `git format-patch` output for validated clean carries
2. `manual/` — PR diffs for every manual reconcile carry
3. `local/` — local-only carry patches from prior prep branches
4. `MANIFEST.md` — single source of truth for provenance + hotspots

---

## LanceDB-specific upgrade plan

This is its own section because it has historically been the most fragile part.

### Risks to guard against

1. runtime dependency path drift after upgrade
2. config schema drift causing plugin registration failure
3. native module load failure after hot reload / restart sequence
4. packaging/runtime mismatch between source tree and installed build

### Required post-upgrade LanceDB checks

After the live upgrade, do **all** of these before calling it good:

1. Confirm the plugin still loads and registers its tools:
   - `memory_recall`
   - `memory_store`
   - `memory_forget`
   - `memory_refresh` (if carried)
2. Confirm the runtime dependency is resolvable from the installed build, not just the source tree.
3. Confirm the runtime dir is writable and the auto-install path succeeds if bundled runtime import fails.
4. Confirm `memory_forget` shows full IDs.
5. Confirm embedding timeout/retry config is honored.
6. If the graceful-degradation patch is carried, verify that bad config disables only memory tools rather than crashing the whole gateway.

### LanceDB carry call

I would currently treat these as the must-have LanceDB-related carries:

- `#56532` — embedding timeout/retry controls
- `#56536` — full IDs in forget candidates
- local `7d0f609e0b` — strip media annotations from recalled memories
- `#43498` — **manual** carry if we want `memory_refresh`
- local `29a6e46a82` — **manual/conditional** graceful degradation, recommended if we still distrust upgrade-time config drift

---

## Telegram-specific upgrade plan

Telegram is the other major sharp edge.

### Must re-check after live upgrade

1. empty-text chunk skipping
2. retry behavior for 429 / failed-after transport errors
3. reply threading after chunk skips
4. startup webhook / getUpdates behavior
5. reply-media download logic for bot-authored replied-to messages
6. long-poll stability after restart

### Telegram carry call

Recommended replay posture:

- definitely carry or reconcile:
  - `#42485`
  - `#49391`
  - `#57280`
  - `#39205`
  - local `b172f7987c`
- do **not** stack these blindly; the empty-text + retry family overlaps and should be reconciled as one Telegram patch set.

---

## Suggested live replay order when you say `go`

### Phase 1 — create the upgrade worktree

1. fresh worktree from `v2026.4.9`
2. export distpatches
3. run the clean carry batch

### Phase 2 — memory/auth low-risk carries

1. `#56532`
2. `#56536`
3. `#57137`
4. local `7d0f609e0b`
5. `#52030`

### Phase 3 — Telegram family as one focused reconcile

Reconcile together:

- `#42485`
- `#49391`
- `#57280`
- `#39205`
- local `b172f7987c`
- conditional local `9846d8588c`

Then run Telegram-targeted tests immediately.

### Phase 4 — memory/session indexing family

Reconcile together:

- `#49220`
- `#43498`
- local `29a6e46a82` (if still needed)

Then run memory/LanceDB smoke tests immediately.

### Phase 5 — agent/runtime reliability carries

Reconcile together:

- `#56166`
- `#56529`
- `#56537`
- `#43497`
- `#49420`
- `#49431`
- `#49429`

These are the highest-risk carries because they touch active-run lifecycle, auth store semantics, restart recovery, and ACP dispatch.

---

## Test matrix for the live run

### Must pass before the gateway swap

#### Packaging / install
- build succeeds
- packaged runtime starts
- bundled plugin/channel sidecars resolve
- memory-lancedb runtime resolves in installed build

#### Telegram
- normal reply send
- long multi-chunk reply
- first-chunk-empty / later-chunk-empty path
- 429 retry behavior
- failed-after transport retry behavior
- reply threading preserved
- monitor startup / long-poll stable

#### Memory
- recall works
- store works
- forget shows full IDs
- session indexing strips inbound metadata + reply tags correctly (if carried)
- memory_refresh preview + replace works (if carried)

#### Agents / runtime
- cron isolated agent run
- fallback model does not persist incorrectly (if carried)
- subagent run survives restart classification correctly
- orphan detection does not false-error completed transcript runs
- ACP abort / timeout does not produce ghost turns
- pending-inbound / restart recovery behavior still sane

#### Auth
- env-var-backed auth sync works
- auth profiles are not cross-contaminated across agent scopes
- `models auth clean` behavior is safe (if carried)

---

## What I would not do on the live pass

1. I would **not** blindly replay every old upgrade-branch commit.
2. I would **not** assume a PR is safe just because its base commit cherry-picks cleanly.
3. I would **not** combine the whole Telegram carry family without immediate focused testing.
4. I would **not** trust LanceDB just because the process boots.
5. I would **not** bring over the 4.2-only compatibility hotfixes unless the packaged build reproduces the exact issue again.

---

## Validation status (checked on 2026-04-10)

What I re-validated on this prep branch:

- `bash -n scripts/carry-upgrade-v2026.4.9.sh` ✅
- `bash -n scripts/export-distpatches-v2026.4.9.sh` ✅
- `scripts/export-distpatches-v2026.4.9.sh` reruns cleanly and leaves the branch clean ✅
- `scripts/carry-upgrade-v2026.4.9.sh replay-safe` succeeds from a fresh `v2026.4.9` worktree when run inside that worktree (or with `TARGET_REPO` set) ✅
- `git am distpatches/v2026.4.9/clean/*.patch` succeeds from a fresh `v2026.4.9` worktree ✅
- `git am distpatches/v2026.4.9/local/local-memory-lancedb-strip-media-annotations.patch` succeeds after the clean patch batch ✅
- `git am distpatches/v2026.4.9/local/local-telegram-longpoll-headroom.patch` succeeds after the clean patch batch ✅
- `local/local-memory-lancedb-strip-media-annotations.patch` is now exported from a rebased disposable worktree on top of the validated clean batch, so the sequential replay path is explicit and replay-safe ✅
- `scripts/carry-upgrade-v2026.4.9.sh` now targets the current git worktree (or explicit `TARGET_REPO`) instead of implicitly mutating the prep branch checkout that contains the script ✅

### Validation caveats

1. I compared the new carry inventory against the old `upgrade/2026-03-31` carry list.
   - The only old explicit carries not separately represented now are `#59242` and `#59243`.
   - `#59242` (self-authored reply-media guard) is effectively covered by the `#57280` manual diff family.
   - `#59243` was a test-only import-lightening carry and is **not** currently called out separately; re-audit it only if contract/plugin import tests regress during the live pass.
2. I did **not** run the full unit/build matrix in the disposable worktrees because dependencies were not installed there.
   - So this prep branch is validated for **artifact correctness + replay mechanics**, not yet for a cold dependency install + full test pass.
   - The live go-pass should still install deps and run the targeted post-reconcile tests called out below.

## Current recommendation

This branch is now in a good prep state for a controlled live upgrade:

- the target version is fixed (`v2026.4.9`)
- the prior upgrade branches were mined
- the carry inventory is classified
- safe carries are separated from manual carries
- distpatch export tooling is prepared
- LanceDB and Telegram are called out as dedicated risk buckets

### If you say `go`, the next step should be:

1. create a fresh execution worktree from `v2026.4.9`
2. export distpatches
3. replay the safe batch
4. reconcile the manual queue family-by-family
5. run the test matrix above
6. only then touch the installed gateway

---

## Open questions to resolve during the live pass

These are not blockers for prep, but they should be answered during the actual upgrade execution:

1. Do we still want the local graceful-degradation LanceDB patch once the upstream runtime manifest fix is in place?
2. Do we want the full `memory_refresh` feature (`#43498`) carried immediately, or can it be a second pass after the base upgrade is stable?
3. Should `#49431` (pending inbound / active-turn recovery) be carried in the same live pass, or isolated after the baseline `v2026.4.9` build is stable?
4. Same question for `#49429` (`models auth clean`) — useful, but not required just to get the base runtime healthy.

My bias for the live run: **stability first**, then extra ergonomics/features.
