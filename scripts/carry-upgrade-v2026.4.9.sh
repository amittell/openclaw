#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${TARGET_REPO:-}" ]]; then
  ROOT_DIR="$(cd "$TARGET_REPO" && pwd)"
else
  ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi

if [[ -z "$ROOT_DIR" ]]; then
  echo "Error: run this from inside the target git worktree or set TARGET_REPO=/path/to/worktree" >&2
  exit 1
fi

cd "$ROOT_DIR"

BASE_TAG="v2026.4.9"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"

SAFE_COMMITS=(
  "59d2d5aa6818303dc1e984c716e60f3b08065e8e|52030|fix(agent): treat Anthropic long-context usage errors as context overflow for compact+retry"
  "871a86eed71779dca2e3837fde8b37084174cfb3|56532|memory-lancedb: add configurable timeout and retry limits for embedding calls"
  "d4882f6b42cf|56536|fix(memory-lancedb): show full IDs in memory_forget candidate list"
  "17a97e50d5535f0033b8d4aa0f57bb8b9d0a54c0|57137|fix(auth): sync env-var-backed token credentials into agent auth store"
)

LOCAL_CLEAN_COMMITS=(
  "7d0f609e0b|local-memory-media-strip|fix(memory-lancedb): strip media annotations from recalled memories"
  "b172f7987c|local-telegram-longpoll-headroom|fix(telegram): give getUpdates long-poll headroom"
)

MANUAL_QUEUE=(
  "39205|manual|Telegram monitor latch reset: port old src/telegram/monitor.ts logic into extensions/telegram/src/monitor.ts"
  "42485|manual|Telegram retry family: reconcile with #49391 and local empty-text carry before applying"
  "43497|manual|Subagent restart recovery: full reviewed PR, not just the base commit"
  "43498|manual|memory_refresh + host session-files carry"
  "49220|manual|session indexing path moved to packages/memory-host-sdk/src/host/session-files.ts"
  "49391|manual|Telegram empty-text family overlaps #42485 and local reconcile carry"
  "49420|manual|ACP abort/ghost-turn prevention across dispatch-acp + ACP manager files"
  "49429|manual|models auth clean conflicts with current auth-profiles modular layout"
  "49431|manual|pending-inbound / active-turn restart recovery conflicts with current gateway startup code"
  "56166|manual|subagent orphan reconcile conflicts in src/agents/subagent-registry-helpers.ts"
  "56529|manual|overload backoff ceiling conflicts in run.ts + schema/help/labels"
  "56537|manual|fallback model persistence fix conflicts in cron/session runtime surfaces"
  "57280|manual|reply-media guard must be ported onto current Telegram handler layout"
  "29a6e46a82|manual|local LanceDB graceful-degradation carry conflicts in extensions/memory-lancedb/index.ts"
  "9846d8588c|manual|local Telegram empty-text reconcile overlaps #42485/#49391 family"
)

REAUDIT_ONLY=(
  "969fb098fb|re-audit|ui/browser import fix; likely 4.2-era compatibility only"
  "6d7af32cee|re-audit|forward-only validator drop was explicitly a 4.2 bridge fix"
  "8db3877d5f|re-audit|AJV defer fix only if packaged build still reproduces stack overflow"
)

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  fetch            Fetch upstream tags + PR refs used by this upgrade plan
  replay-safe      Cherry-pick the validated clean carry batch onto the current branch
  print-manual     Print the manual reconcile queue
  print-reaudit    Print the re-audit-only queue
  summary          Print a one-screen summary

Notes:
  - Run this from inside the target upgrade worktree based on ${BASE_TAG}, or set TARGET_REPO=/path/to/that/worktree.
  - The script applies carries to the current git worktree; it does not implicitly target the checkout that contains this script.
  - replay-safe intentionally excludes the risky/manual carry families.
  - For full patch artifacts, run scripts/export-distpatches-v2026.4.9.sh from the prep branch checkout.
EOF
}

fetch_refs() {
  git fetch "$UPSTREAM_REMOTE" --tags
  local prs=(52030 56532 56536 57137 39205 42485 43497 43498 49220 49391 49420 49429 49431 56166 56529 56537 57280)
  for pr in "${prs[@]}"; do
    git fetch "$UPSTREAM_REMOTE" "pull/${pr}/head:refs/remotes/${UPSTREAM_REMOTE}/pr/${pr}" >/dev/null 2>&1 || true
  done
  echo "Fetched tags and PR refs from ${UPSTREAM_REMOTE}."
}

replay_group() {
  local label="$1"
  shift
  local entries=("$@")
  echo "== ${label} =="
  for entry in "${entries[@]}"; do
    IFS='|' read -r sha ref title <<<"$entry"
    echo "Cherry-picking ${sha} (${ref}) — ${title}"
    git cherry-pick -x "$sha"
  done
}

print_queue() {
  local heading="$1"
  shift
  local entries=("$@")
  echo "== ${heading} =="
  for entry in "${entries[@]}"; do
    IFS='|' read -r ref kind note <<<"$entry"
    printf ' - [%s] %s\n' "$ref" "$note"
  done
}

summary() {
  cat <<EOF
Target base: ${BASE_TAG}

Validated clean replay batch:
$(for entry in "${SAFE_COMMITS[@]}"; do IFS='|' read -r sha ref title <<<"$entry"; printf '  - %s %s\n' "$ref" "$title"; done)

Validated local clean carries:
$(for entry in "${LOCAL_CLEAN_COMMITS[@]}"; do IFS='|' read -r sha ref title <<<"$entry"; printf '  - %s %s\n' "$ref" "$title"; done)

Manual reconcile queue:
$(for entry in "${MANUAL_QUEUE[@]}"; do IFS='|' read -r ref kind note <<<"$entry"; printf '  - %s %s\n' "$ref" "$note"; done)

Re-audit only:
$(for entry in "${REAUDIT_ONLY[@]}"; do IFS='|' read -r ref kind note <<<"$entry"; printf '  - %s %s\n' "$ref" "$note"; done)
EOF
}

cmd="${1:-}"
case "$cmd" in
  fetch)
    fetch_refs
    ;;
  replay-safe)
    replay_group "safe upstream carries" "${SAFE_COMMITS[@]}"
    replay_group "safe local carries" "${LOCAL_CLEAN_COMMITS[@]}"
    ;;
  print-manual)
    print_queue "manual reconcile queue" "${MANUAL_QUEUE[@]}"
    ;;
  print-reaudit)
    print_queue "re-audit-only carries" "${REAUDIT_ONLY[@]}"
    ;;
  summary)
    summary
    ;;
  *)
    usage
    exit 1
    ;;
esac
