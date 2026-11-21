#!/usr/bin/env bash
# Agent Stop hook (ZCode, WorkBuddy, ...): commit workspace changes once per
# agent turn.
# Commit message: auto-commit-msg.cjs turns the agent's final reply (Stop hook
# stdin JSON field last_assistant_message) into a Conventional Commits subject
# plus an AI-written body; a local heuristic is used when the model is
# unavailable. The model source follows the detected agent, exported to the
# helper as AUTOCOMMIT_AGENT: WorkBuddy/CodeBuddy use the per-session
# WORKBUDDY_VLM_* environment endpoint, ZCode reads provider_config.json.
# Nothing is written to stdout: hook stdout is parsed as strict JSON, and
# non-zero exits are recorded as hook failures.
# Runtime: a real node from PATH when available, otherwise the host agent's
# Electron binary run as Node via ELECTRON_RUN_AS_NODE=1 (ZCode, WorkBuddy, ...).
# AUTOCOMMIT_NODE overrides the runtime for tests or unusual installs.
# Git-Bash launchers may start with a Windows-only PATH. Coreutils, cygpath and
# mktemp live in /usr/bin, so add it when it is not already present.
case ":$PATH:" in
  *:/usr/bin:*) ;;
  *) [ -d /usr/bin ] && PATH="/usr/bin:/bin:$PATH" ;;
esac

# Resolve this script before changing directory: $0 may be relative, and the
# hook later cd's into the project directory.
script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path" 2>/dev/null || printf '%s' "$script_path") ;;
esac
# Process hooks pass a Windows path on Windows; dirname only understands the
# POSIX form, and a failed lookup would silently lose the message helper.
if command -v cygpath >/dev/null 2>&1; then
  script_path=$(cygpath -u "$script_path" 2>/dev/null || printf '%s' "$script_path")
fi
script_dir=$(cd "$(dirname "$script_path")" 2>/dev/null && pwd)

# --- Host agent -------------------------------------------------------------
# Every desktop agent exports its own environment-variable prefix, so the host
# can be identified by plain parameter expansion - no subprocess, no process
# scan. Verified against real hook-env dumps: WorkBuddy sets WORKBUDDY_*/WB_*
# plus the shared CODEBUDDY_*/CLAUDE_* pair but no ZCODE_*; ZCode sets
# ZCODE_* plus the CLAUDE_* pair. Brand-specific prefixes are checked before
# the shared CODEBUDDY_* one (WorkBuddy also sets CODEBUDDY_HOST). WorkBuddy
# exposes WB_SHT_INSTDIR (install root) and WORKBUDDY_APP_PATH (often
# resources/app.asar, not the exe).
agent=unknown
if [ -n "${WORKBUDDY_PRODUCT_NAME:-}${WORKBUDDY_APP_PATH:-}${WORKBUDDY_IS_PACKAGED:-}${WB_SHT_INSTDIR:-}${WORKBUDDY_NODE_FALLBACK_EXEC_PATH:-}${WORKBUDDY_WINDOWS_APP_INSTALL_DIR:-}${WORKBUDDY_APP_INSTALL_DIR:-}${WORKBUDDY_PROJECT_DIR:-}" ]; then
  agent=workbuddy
elif [ -n "${ZCODE_PROJECT_DIR:-}${ZCODE_SESSION_ID:-}${ZCODE_NODE_FALLBACK_EXEC_PATH:-}${ZCODE_WINDOWS_APP_INSTALL_DIR:-}" ]; then
  agent=zcode
elif [ -n "${CODEBUDDY_HOST:-}${CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT:-}" ]; then
  agent=codebuddy:${CODEBUDDY_HOST:-codebuddy}
fi

# Model source selector for auto-commit-msg.cjs (workbuddy | codebuddy:* |
# zcode | unknown).
AUTOCOMMIT_AGENT=$agent
export AUTOCOMMIT_AGENT

cd "${ZCODE_PROJECT_DIR:-${WORKBUDDY_PROJECT_DIR:-${CODEBUDDY_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}}}" >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Read the Stop hook payload (JSON on stdin); a TTY means it was run by hand.
# Both hosts send it as compact single-line JSON.
hook_input=""
[ -t 0 ] || hook_input=$(cat 2>/dev/null)

# Never interfere with an in-progress merge/rebase/am or unresolved conflicts.
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
[ -e "$gitdir/MERGE_HEAD" ] && exit 0
[ -d "$gitdir/rebase-merge" ] && exit 0
[ -d "$gitdir/rebase-apply" ] && exit 0
[ -n "$(git ls-files -u)" ] && exit 0
# A detached HEAD would leave the checkpoint unreferenced once HEAD moves on.
git symbolic-ref -q HEAD >/dev/null || exit 0

# Skip when the tree is clean (no staged/unstaged/untracked changes)
if git diff --quiet HEAD 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  exit 0
fi

git add -A >/dev/null 2>&1 || exit 0
git diff --cached --quiet && exit 0  # nothing stageable changed

file_count=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
changed=$(git diff --cached --name-only 2>/dev/null | head -n 200)

helper="$script_dir/auto-commit-msg.cjs"

# --- JavaScript runtime -----------------------------------------------------
# Prefer a real Node.js. Desktop agents ship an Electron binary that doubles as
# Node when ELECTRON_RUN_AS_NODE=1, so the hook still works without a standalone
# Node install. The variable is harmless for a real node binary, so it is set
# for every candidate.

to_posix() {
  cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
}

runtime=""
set_runtime() {
  local cand
  [ -n "$1" ] || return 1
  case "$1" in *.cmd|*.bat) return 1 ;; esac   # bash cannot exec these directly
  cand=$(to_posix "$1")
  [ -f "$cand" ] && [ -x "$cand" ] || return 1
  runtime=$cand
}

set_runtime "$(command -v node 2>/dev/null || true)"

# Explicit override for tests or unusual installs.
if [ -z "$runtime" ]; then
  set_runtime "${AUTOCOMMIT_NODE:-}"
fi

# Known agent install locations, then portable Node installs. The env-derived
# agent hint decides which host's paths are tried first; no process scanning.
if [ -z "$runtime" ]; then
  zcode_paths=(
    "${ZCODE_WINDOWS_APP_INSTALL_DIR:-}/ZCode.exe"
    "${LOCALAPPDATA:-}/Programs/ZCode/ZCode.exe"
  )
  workbuddy_paths=(
    "${WB_SHT_INSTDIR:-}/WorkBuddy.exe"
    "${LOCALAPPDATA:-}/Programs/WorkBuddy/WorkBuddy.exe"
    "/c/Program Files/WorkBuddy/WorkBuddy.exe"
    "/c/Program Files (x86)/WorkBuddy/WorkBuddy.exe"
  )
  codebuddy_paths=(
    "${LOCALAPPDATA:-}/Programs/CodeBuddy/CodeBuddy.exe"
  )
  case "$agent" in
    workbuddy)
      agent_paths=("${workbuddy_paths[@]}" "${codebuddy_paths[@]}" "${zcode_paths[@]}")
      ;;
    codebuddy:*)
      agent_paths=("${codebuddy_paths[@]}" "${workbuddy_paths[@]}" "${zcode_paths[@]}")
      ;;
    zcode)
      agent_paths=("${zcode_paths[@]}" "${workbuddy_paths[@]}" "${codebuddy_paths[@]}")
      ;;
    *)
      agent_paths=("${zcode_paths[@]}" "${workbuddy_paths[@]}" "${codebuddy_paths[@]}")
      ;;
  esac
  node_paths=(
    "$HOME/scoop/shims/node.exe"
    "$HOME/scoop/apps/nodejs-lts/current/node.exe"
    "$HOME/scoop/apps/nodejs/current/node.exe"
    "/c/Program Files/nodejs/node.exe"
  )
  for cand in "${agent_paths[@]}" "${node_paths[@]}"; do
    set_runtime "$cand" && break
  done
fi

msgfile=$(mktemp) || exit 0
if [ -n "$runtime" ] && [ -f "$helper" ]; then
  printf '%s' "$hook_input" | CHANGED="$changed" ELECTRON_RUN_AS_NODE=1 "$runtime" "$helper" > "$msgfile" 2>/dev/null
fi
if [ ! -s "$msgfile" ]; then
  if [ "$file_count" -eq 1 ]; then unit=file; else unit=files; fi
  printf 'chore: update %s %s\n' "$file_count" "$unit" > "$msgfile"
fi

git -c commit.gpgsign=false commit -F "$msgfile" --no-verify >/dev/null 2>&1
rm -f "$msgfile"
exit 0
