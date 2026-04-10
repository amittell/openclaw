# distpatches/v2026.4.9

## clean/

Validated clean replay artifacts against `v2026.4.9`:

- `PR-52030-anthropic-long-context-compact.patch`
- `PR-56532-lancedb-embedding-timeout-retry.patch`
- `PR-56536-memory-forget-full-ids.patch`
- `PR-57137-auth-sync-env-var-backed-token-credentials.patch`

## manual/

PR diffs to use as reconcile references:

- `PR-39205-telegram-monitor-webhookcleared-409-loop.diff`
- `PR-42485-telegram-retry-regressions-v2.diff`
- `PR-43497-subagent-restart-resume-phase1.diff`
- `PR-43498-memory-lancedb-refresh.diff`
- `PR-49220-memory-session-index-strip-inbound-meta.diff`
- `PR-49391-empty-text-silent-skip-v2.diff`
- `PR-49420-acp-dispatch-abort-signal-v3.diff`
- `PR-49429-auth-clean-v2.diff`
- `PR-49431-inbound-drain-queue-v3.diff`
- `PR-56166-subagent-orphan-reconcile-v2.diff`
- `PR-56529-overload-backoff-ceiling-v2.diff`
- `PR-56537-fallback-model-no-persist-v2.diff`
- `PR-57280-telegram-reply-self-media.diff`

## local/

Prior local carry artifacts:

- `local-memory-lancedb-strip-media-annotations.patch`
- `local-telegram-longpoll-headroom.patch`
- `local-memory-lancedb-graceful-degradation.patch`
- `local-telegram-empty-text-reconcile.patch`
- `local-ui-avoid-browser-import-of-node-module.patch`
- `local-build-drop-forward-only-validators.patch`
- `local-gateway-defer-ajv-compilation.patch`

## notes

- `clean/` is the only bucket intended for blind replay.
- `manual/` is for family-by-family reconciliation on top of `v2026.4.9`.
- `local/` includes both low-risk local carries and 4.2-era conditional compatibility patches.
- Validation check on 2026-04-10:
  - `git am clean/*.patch` works from a fresh `v2026.4.9` worktree.
  - `git am local/local-telegram-longpoll-headroom.patch` also works after the clean batch.
  - `local/local-memory-lancedb-strip-media-annotations.patch` does **not** apply cleanly as a raw sequential `git am` after the clean batch, even though the underlying commit cherry-picks cleanly. For the live run, replay that carry via `scripts/carry-upgrade-v2026.4.9.sh replay-safe` unless a rebased patch artifact is generated.
