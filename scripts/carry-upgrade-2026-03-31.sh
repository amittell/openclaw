#!/usr/bin/env bash
set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
BASE_TAG="${BASE_TAG:-v2026.3.31}"
UPGRADE_BRANCH="${UPGRADE_BRANCH:-upgrade/2026-03-31}"

CLEAN_COMMITS=(
  "cfa1355c68|57280|fix(telegram): skip reply media download when replied-to message is from bot"
  "149c4d2eb5|56532|memory-lancedb: add configurable timeout and retry limits for embedding calls"
  "e304c3cd9c|56166|fix(agents): check transcript validity before marking subagent runs as orphaned"
  "59d2d5aa68|52030|fix(agent): treat Anthropic long-context usage errors as context overflow for compact+retry"
  "d4882f6b42|56536|fix(memory-lancedb): show full IDs in memory_forget candidate list (code-only replay)"
  "17a97e50d5|57137|fix(auth): sync env-var-backed token credentials into agent auth store (auth-only replay)"
)

FOLLOWUP_COMMITS=(
  "63237c0ffd|4050307baf|59242|fix(telegram): restore self-authored reply-media guard"
  "635eac269b|3f08b85d42|59243|test(contracts): avoid heavy plugin-sdk testing imports"
)

LOCAL_CARRIES=(
  "7d0f609e0b|fix(memory-lancedb): strip media annotations from recalled memories"
  "9846d8588c|fix(telegram): reconcile empty-text delivery on 2026.3.31"
)

POST_DIST_CARRIES=(
  "a621c7b237|fix(telegram): restore retry behaviour for 429 rate-limit and failed-after network errors"
  "dcef07efe0|fix(telegram): address PR #40383 review feedback"
  "e17556d847|fix(telegram): address review feedback on hasTelegramRetryAfterParameter"
  "e20d108a7e|fix(agents): stop transient live-switch mismatches"
  "68c3e9b06b|feat(memory-lancedb): add memory_refresh tool for atomic replace and conflict preview (#43498)"
  "3e14ff5802|fix(gateway): prevent session death loop on overloaded fallback"
)

POST_DIST_ABSORBED=(
  "0ad068d2f2|fix: complete cron isolated model-switch retry (#57972)|already functionally present on upgrade/2026-03-31 during rh-bot audit; no separate replay commit required"
  "42bf4998d3|fix(telegram): reset webhook cleanup latch after polling 409 conflicts (#39205)|already contained in upstream v2026.3.31"
)

MANUAL_QUEUE=(
  "56529|fix/overload-backoff-ceiling-v2|manual reconcile|src/agents/pi-embedded-runner/run.ts"
  "56537|fix/fallback-model-no-persist-v2|manual reconcile|src/agents/command/session-store.ts; src/cron/isolated-agent/run.ts"
  "49429|fix/auth-clean-v2|manual reconcile|src/agents/auth-profiles.runtime.ts; src/agents/auth-profiles/store.ts"
  "49431|feat/inbound-drain-queue-v3|manual reconcile|src/gateway/server-startup.ts; src/infra/system-events.ts"
  "49420|fix/acp-dispatch-abort-signal-v3|manual reconcile|src/auto-reply/reply/dispatch-acp.ts"
  "49220|fix/memory-session-index-strip-inbound-meta|manual reconcile|packages/memory-host-sdk/src/host/session-files.ts; src/utils/directive-tags.ts"
  "43498|feat/memory-lancedb-refresh|manual reconcile|packages/memory-host-sdk/src/host/session-files.ts; extensions/memory-lancedb/index.ts"
  "43497|feat/subagent-restart-resume-phase1|manual reconcile|src/agents/subagent-registry.ts"
  "39205|fix/telegram-polling-webhookcleared-409-loop|manual reconcile with path move|extensions/telegram/src/monitor.ts"
  "42485|fix/telegram-retry-regressions-v2|reconstruct from PR diff before replay|branch currently overlaps empty-text patch family"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/carry-upgrade-2026-03-31.sh prepare
  scripts/carry-upgrade-2026-03-31.sh replay-clean
  scripts/carry-upgrade-2026-03-31.sh status
  scripts/carry-upgrade-2026-03-31.sh manual-queue

Environment:
  UPSTREAM_REMOTE  Default: upstream
  UPSTREAM_URL     Default: https://github.com/openclaw/openclaw.git
  BASE_TAG         Default: v2026.3.31
  UPGRADE_BRANCH   Default: upgrade/2026-03-31

Notes:
  - prepare creates or switches to the upgrade branch from BASE_TAG.
  - replay-clean cherry-picks the low-friction carry batch, validated follow-up carries, and local carries with -x provenance.
  - status reports the clean replay batch, follow-up carries, local carries, and the audited post-dist delta from rh-bot.
EOF
}

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

repo_root() {
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    git rev-parse --show-toplevel
    return 0
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  git -C "${script_dir}/.." rev-parse --show-toplevel
}

ensure_repo_root() {
  local root
  root="$(repo_root)"
  cd "$root"
}

ensure_upstream_remote() {
  if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    return 0
  fi
  log "adding remote $UPSTREAM_REMOTE -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
}

fetch_base() {
  ensure_upstream_remote
  log "fetching $UPSTREAM_REMOTE tag $BASE_TAG"
  git fetch "$UPSTREAM_REMOTE" --tags --quiet
  git rev-parse --verify --quiet "refs/tags/$BASE_TAG^{commit}" >/dev/null \
    || fail "missing tag $BASE_TAG after fetch"
}

require_no_tracked_changes() {
  git diff --quiet --ignore-submodules -- || fail "tracked working tree changes present; commit or stash them first"
  git diff --cached --quiet --ignore-submodules -- || fail "staged changes present; commit or stash them first"
}

current_branch() {
  git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "DETACHED"
}

prepare_branch() {
  ensure_repo_root
  fetch_base
  require_no_tracked_changes

  if git show-ref --verify --quiet "refs/heads/$UPGRADE_BRANCH"; then
    log "switching to existing branch $UPGRADE_BRANCH"
    git switch "$UPGRADE_BRANCH" >/dev/null
  else
    log "creating $UPGRADE_BRANCH from $BASE_TAG"
    git switch -c "$UPGRADE_BRANCH" "$BASE_TAG" >/dev/null
  fi
  log "branch ready: $(current_branch) @ $(git rev-parse --short HEAD)"
}

replayed_marker_present() {
  local sha="$1"
  [[ -n "$(git log --grep="cherry picked from commit ${sha}" --format=%H -n 1 HEAD)" ]]
}

commit_present_on_head() {
  local sha="$1"
  git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1 || return 1
  git merge-base --is-ancestor "$sha" HEAD >/dev/null 2>&1
}

replayed_or_present() {
  local source_sha="$1"
  local integrated_sha="${2:-}"

  replayed_marker_present "$source_sha" && return 0
  commit_present_on_head "$source_sha" && return 0

  if [[ -n "$integrated_sha" ]]; then
    commit_present_on_head "$integrated_sha" && return 0
  fi

  return 1
}

replay_commit() {
  local sha="$1"
  local ref="$2"
  local label="$3"

  if replayed_marker_present "$sha"; then
    log "skip $ref ($label): already replayed"
    return 0
  fi

  git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null \
    || fail "missing commit $sha; fetch the relevant origin branch first"

  log "cherry-picking $ref ($label) from $sha"
  if ! git cherry-pick -x "$sha"; then
    printf '\n' >&2
    printf 'Cherry-pick stopped on %s (%s).\n' "$sha" "$ref" >&2
    printf 'Resolve conflicts, then run:\n' >&2
    printf '  git cherry-pick --continue\n' >&2
    printf 'or abort with:\n' >&2
    printf '  git cherry-pick --abort\n' >&2
    exit 1
  fi
}

replay_clean() {
  ensure_repo_root
  prepare_branch
  log "fetching origin for carry commits"
  git fetch origin --quiet

  local entry sha pr label
  for entry in "${CLEAN_COMMITS[@]}"; do
    IFS='|' read -r sha pr label <<<"$entry"
    replay_commit "$sha" "PR #$pr" "$label"
  done
  for entry in "${FOLLOWUP_COMMITS[@]}"; do
    IFS='|' read -r sha _integrated_sha pr label <<<"$entry"
    replay_commit "$sha" "PR #$pr" "$label"
  done
  for entry in "${LOCAL_CARRIES[@]}"; do
    IFS='|' read -r sha label <<<"$entry"
    replay_commit "$sha" "local carry" "$label"
  done

  log "clean batch replay complete"
  print_status
}

print_status() {
  ensure_repo_root
  printf 'Branch: %s\n' "$(current_branch)"
  printf 'HEAD:   %s\n' "$(git rev-parse --short HEAD)"
  printf 'Base:   %s (%s)\n' "$BASE_TAG" "$(git rev-parse --short "$BASE_TAG^{commit}")"
  printf '\nClean batch:\n'

  local entry sha pr label
  for entry in "${CLEAN_COMMITS[@]}"; do
    IFS='|' read -r sha pr label <<<"$entry"
    if replayed_or_present "$sha"; then
      printf '  [done] PR #%s %s\n' "$pr" "$label"
    else
      printf '  [todo] PR #%s %s\n' "$pr" "$label"
    fi
  done

  printf '\nFollow-up carries:\n'
  local integrated_sha
  for entry in "${FOLLOWUP_COMMITS[@]}"; do
    IFS='|' read -r sha integrated_sha pr label <<<"$entry"
    if replayed_or_present "$sha" "$integrated_sha"; then
      printf '  [done] PR #%s %s\n' "$pr" "$label"
    else
      printf '  [todo] PR #%s %s\n' "$pr" "$label"
    fi
  done

  printf '\nLocal carries:\n'
  for entry in "${LOCAL_CARRIES[@]}"; do
    IFS='|' read -r sha label <<<"$entry"
    if replayed_or_present "$sha"; then
      printf '  [done] %s\n' "$label"
    else
      printf '  [todo] %s\n' "$label"
    fi
  done

  printf '\nAudited post-dist carries from build/patched-2026.3.28:\n'
  for entry in "${POST_DIST_CARRIES[@]}"; do
    IFS='|' read -r sha label <<<"$entry"
    if replayed_or_present "$sha"; then
      printf '  [done] %s\n' "$label"
    else
      printf '  [todo] %s\n' "$label"
    fi
  done
  for entry in "${POST_DIST_ABSORBED[@]}"; do
    IFS='|' read -r sha label note <<<"$entry"
    printf '  [absorbed] %s\n' "$label"
    printf '    note: %s\n' "$note"
  done
}

print_manual_queue() {
  printf 'Manual reconcile queue on top of %s:\n' "$BASE_TAG"
  local entry pr branch mode hotspots
  for entry in "${MANUAL_QUEUE[@]}"; do
    IFS='|' read -r pr branch mode hotspots <<<"$entry"
    printf '  PR #%s  %s\n' "$pr" "$branch"
    printf '    mode: %s\n' "$mode"
    printf '    hotspots: %s\n' "$hotspots"
  done
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    prepare)
      prepare_branch
      ;;
    replay-clean)
      replay_clean
      ;;
    status)
      ensure_repo_root
      print_status
      ;;
    manual-queue)
      print_manual_queue
      ;;
    ""|-h|--help|help)
      usage
      ;;
    *)
      fail "unknown command: $cmd"
      ;;
  esac
}

main "$@"
