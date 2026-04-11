#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BASE_TAG="v2026.4.9"
OUT_DIR="distpatches/v2026.4.9"
CLEAN_DIR="${OUT_DIR}/clean"
MANUAL_DIR="${OUT_DIR}/manual"
LOCAL_DIR="${OUT_DIR}/local"

mkdir -p "$CLEAN_DIR" "$MANUAL_DIR" "$LOCAL_DIR"

write_patch() {
  local sha="$1"
  local out="$2"
  git format-patch -1 --stdout "$sha" > "$out"
}

write_rebased_patch() {
  local base_ref="$1"
  local commit_sha="$2"
  local out="$3"
  shift 3
  local prereq_patches=("$@")
  local abs_out
  if [[ "$out" = /* ]]; then
    abs_out="$out"
  else
    abs_out="${ROOT_DIR}/${out}"
  fi

  local tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-distpatch-rebase.XXXXXX")"
  cleanup() {
    git worktree remove --force "$tmp" >/dev/null 2>&1 || true
  }
  trap cleanup RETURN

  git worktree add --detach "$tmp" "$base_ref" >/dev/null
  (
    cd "$tmp"
    local patch abs_patch
    for patch in "${prereq_patches[@]}"; do
      if [[ "$patch" = /* ]]; then
        abs_patch="$patch"
      else
        abs_patch="${ROOT_DIR}/${patch}"
      fi
      git am "$abs_patch" >/dev/null
    done
    git cherry-pick -x "$commit_sha" >/dev/null
    git format-patch --zero-commit -1 --stdout HEAD > "$abs_out"
  )
}

write_pr_diff() {
  local pr="$1"
  local title="$2"
  local out="$3"
  gh pr diff "$pr" --repo openclaw/openclaw > "$out"
}

# Clean replay batch
write_patch 59d2d5aa6818 "${CLEAN_DIR}/PR-52030-anthropic-long-context-compact.patch"
write_patch 871a86eed717 "${CLEAN_DIR}/PR-56532-lancedb-embedding-timeout-retry.patch"
write_patch d4882f6b42cf "${CLEAN_DIR}/PR-56536-memory-forget-full-ids.patch"
write_patch 17a97e50d553 "${CLEAN_DIR}/PR-57137-auth-sync-env-var-backed-token-credentials.patch"

# Local clean carries
write_rebased_patch "$BASE_TAG" 7d0f609e0b1fc3ec3ba06977631eb5254bc75679 "${LOCAL_DIR}/local-memory-lancedb-strip-media-annotations.patch" \
  "${CLEAN_DIR}/PR-52030-anthropic-long-context-compact.patch" \
  "${CLEAN_DIR}/PR-56532-lancedb-embedding-timeout-retry.patch" \
  "${CLEAN_DIR}/PR-56536-memory-forget-full-ids.patch" \
  "${CLEAN_DIR}/PR-57137-auth-sync-env-var-backed-token-credentials.patch"
write_patch b172f7987c "${LOCAL_DIR}/local-telegram-longpoll-headroom.patch"

# Local manual / conditional carries
write_patch 29a6e46a82 "${LOCAL_DIR}/local-memory-lancedb-graceful-degradation.patch"
write_patch 9846d8588c "${LOCAL_DIR}/local-telegram-empty-text-reconcile.patch"
write_patch 969fb098fb "${LOCAL_DIR}/local-ui-avoid-browser-import-of-node-module.patch"
write_patch 6d7af32cee "${LOCAL_DIR}/local-build-drop-forward-only-validators.patch"
write_patch 8db3877d5f "${LOCAL_DIR}/local-gateway-defer-ajv-compilation.patch"

# Manual upstream PR diff artifacts
write_pr_diff 39205 "telegram-monitor-webhookcleared-409-loop" "${MANUAL_DIR}/PR-39205-telegram-monitor-webhookcleared-409-loop.diff"
write_pr_diff 42485 "telegram-retry-regressions-v2" "${MANUAL_DIR}/PR-42485-telegram-retry-regressions-v2.diff"
write_pr_diff 43497 "subagent-restart-resume-phase1" "${MANUAL_DIR}/PR-43497-subagent-restart-resume-phase1.diff"
write_pr_diff 43498 "memory-lancedb-refresh" "${MANUAL_DIR}/PR-43498-memory-lancedb-refresh.diff"
write_pr_diff 49220 "memory-session-index-strip-inbound-meta" "${MANUAL_DIR}/PR-49220-memory-session-index-strip-inbound-meta.diff"
write_pr_diff 49391 "empty-text-silent-skip-v2" "${MANUAL_DIR}/PR-49391-empty-text-silent-skip-v2.diff"
write_pr_diff 49420 "acp-dispatch-abort-signal-v3" "${MANUAL_DIR}/PR-49420-acp-dispatch-abort-signal-v3.diff"
write_pr_diff 49429 "auth-clean-v2" "${MANUAL_DIR}/PR-49429-auth-clean-v2.diff"
write_pr_diff 49431 "inbound-drain-queue-v3" "${MANUAL_DIR}/PR-49431-inbound-drain-queue-v3.diff"
write_pr_diff 56166 "subagent-orphan-reconcile-v2" "${MANUAL_DIR}/PR-56166-subagent-orphan-reconcile-v2.diff"
write_pr_diff 56529 "overload-backoff-ceiling-v2" "${MANUAL_DIR}/PR-56529-overload-backoff-ceiling-v2.diff"
write_pr_diff 56537 "fallback-model-no-persist-v2" "${MANUAL_DIR}/PR-56537-fallback-model-no-persist-v2.diff"
write_pr_diff 57280 "telegram-reply-self-media" "${MANUAL_DIR}/PR-57280-telegram-reply-self-media.diff"

cat > "${OUT_DIR}/MANIFEST.md" <<'EOF'
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
- `local/local-memory-lancedb-strip-media-annotations.patch` is exported from a rebased disposable worktree on top of the validated clean batch, so it now applies cleanly as a raw sequential `git am` after `clean/*.patch`.
EOF

echo "Exported distpatches to ${OUT_DIR}"
