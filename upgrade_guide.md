# OpenClaw 2026.3.31 Upgrade Guide

This repo now includes an executable carry script for the `2026.3.31` upgrade line:

```bash
scripts/carry-upgrade-2026-03-31.sh
```

It is designed for git checkouts of `amittell/openclaw` that need to rebase the fork onto upstream `v2026.3.31` and replay the low-risk carry batch first.

## Branch and base

- Upgrade branch: `upgrade/2026-03-31`
- Upstream base tag: `v2026.3.31`
- Upstream release commit: `213a704b71f4996dc82a583288ee53785215f627`

## Clean batch the script replays

The script cherry-picks these commits with `-x` provenance:

1. `cfa1355c68` / PR `#57280`
   `fix(telegram): skip reply media download when replied-to message is from bot`
2. `149c4d2eb5` / PR `#56532`
   `memory-lancedb: add configurable timeout and retry limits for embedding calls`
3. `e304c3cd9c` / PR `#56166`
   `fix(agents): check transcript validity before marking subagent runs as orphaned`
4. `59d2d5aa68` / PR `#52030`
   `fix(agent): treat Anthropic long-context usage errors as context overflow for compact+retry`
5. `d4882f6b42` / PR `#56536`
   `fix(memory-lancedb): show full IDs in memory_forget candidate list`
   This intentionally replays the code commit only, not the generated baseline rebase commit.
6. `17a97e50d5` / PR `#57137`
   `fix(auth): sync env-var-backed token credentials into agent auth store`
   This intentionally replays the auth-only commit, not the stacked overload-backoff commits from the PR branch.

## Manual queue after the clean batch

Run:

```bash
scripts/carry-upgrade-2026-03-31.sh manual-queue
```

That prints the remaining PRs which still need manual reconcile on top of `v2026.3.31`, including the main conflict hot spots.

## Rh-bot audited post-dist carries now on the branch

After validating `rh-bot.lan`, the working `build/patched-2026.3.28` branch was diffed against
`upgrade/2026-03-31`. The real production-only delta reduced to these source commits:

1. `a621c7b237`
   `fix(telegram): restore retry behaviour for 429 rate-limit and failed-after network errors`
2. `dcef07efe0`
   `fix(telegram): address PR #40383 review feedback`
3. `e17556d847`
   `fix(telegram): address review feedback on hasTelegramRetryAfterParameter`
4. `e20d108a7e`
   `fix(agents): stop transient live-switch mismatches`
5. `68c3e9b06b`
   `feat(memory-lancedb): add memory_refresh tool for atomic replace and conflict preview (#43498)`
6. `3e14ff5802`
   `fix(gateway): prevent session death loop on overloaded fallback`

These are now integrated on `upgrade/2026-03-31` as:

1. `dad323c57f`
2. `d5c4c3fd3f`
3. `653debc6ce`
4. `d3918e53ad`
5. `54306cd15d`
6. `b52958d28b`

Two older candidates did not require extra replay:

- `0ad068d2f2` `fix: complete cron isolated model-switch retry (#57972)`
  Functional logic was already present on `upgrade/2026-03-31` during the rh-bot audit.
- `42bf4998d3` `fix(telegram): reset webhook cleanup latch after polling 409 conflicts (#39205)`
  Already included in upstream `v2026.3.31`.

## Typical host workflow

From the repo root:

```bash
scripts/carry-upgrade-2026-03-31.sh prepare
scripts/carry-upgrade-2026-03-31.sh replay-clean
scripts/carry-upgrade-2026-03-31.sh status
scripts/carry-upgrade-2026-03-31.sh manual-queue
```

The script requires a clean tracked worktree. Untracked files are tolerated.

## Validation after replay

After switching a host to the audited branch, run the repo’s source-install validation flow:

```bash
npx pnpm install --frozen-lockfile
npx pnpm build
openclaw --version
openclaw doctor --fix
openclaw gateway restart
openclaw health
```

If `openclaw doctor --fix` reports `Missing UI runner: install pnpm, then retry`, install a real
`pnpm` binary first:

```bash
npm install -g pnpm@10
openclaw doctor --fix
```

If `openclaw --version` still points at an older global install after the build, relink the repo:

```bash
npm link
openclaw --version
```

On macOS LaunchAgent installs, confirm the live service is using the repo checkout:

```bash
launchctl print gui/$(id -u)/ai.openclaw.gateway | sed -n '1,80p'
```

Expected signs:

- `arguments` points at `<repo>/dist/index.js`
- `OPENCLAW_SERVICE_VERSION` is `2026.3.31`
- `openclaw health` reports the gateway as healthy after restart

## Rh-bot rollout notes

- `rh-bot.lan` originally had only `origin`; `upstream` had to be added before `BASE_TAG` checks
  in the carry script could resolve cleanly.
- The machine had a stale global `openclaw@2026.3.28` in `/opt/homebrew/lib/node_modules/openclaw`.
  Building the repo was not enough; `npm link` was required to move the live CLI and LaunchAgent to
  the repo checkout.
- `doctor --fix` initially failed because only `npx pnpm` existed. A global `pnpm@10` install fixed
  the UI-rebuild path.
- The narrowed Telegram reply-media test still hung on both local and `rh-bot`; treat service
  health plus the targeted non-Telegram suites as the practical gate until that test hang is
  understood.

For local macOS smoke tests during integration:

```bash
scripts/restart-mac.sh
```

For final signed release artifacts on macOS:

```bash
SKIP_NOTARIZE=1 \
BUNDLE_ID=ai.openclaw.mac \
APP_VERSION=2026.3.31 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh
```

Or use the notarized flow described in `docs/platforms/mac/release.md`.
