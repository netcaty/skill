#!/usr/bin/env bash
# Agent Stop hook (ZCode, WorkBuddy, ...): commit workspace changes once per
# agent turn.
# Commit message: auto-commit-msg.cjs turns the agent's final reply (Stop hook
# stdin JSON field last_assistant_message) into a Conventional Commits subject
# plus an AI-written body; a local heuristic is used when the model is
# unavailable. The model source follows the detected agent, exported to the
# helper as AUTOCOMMIT_AGENT: WorkBuddy/CodeBuddy use the per-session
# WORKBUDDY_VLM_* environment endpoint, ZCode reads provider_config.json, and
# Claude Code uses the session's ANTHROPIC_* endpoint/model environment.
# Sensitive files: obvious secret names are unstaged by name (layer 1), and the
# helper may flag more from the staged diff (layer 2); both layers are
# best-effort and every excluded path is listed in the commit body.
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
# scan. The marker table below mirrors the AGENT_PROFILES registry in
# scripts/lib.cjs (the authoritative source); rows run in order, brand-specific
# markers before shared ones. Verified against real hook-env dumps: WorkBuddy
# sets WORKBUDDY_*/WB_* plus the shared CODEBUDDY_*/CLAUDE_* pair but no
# ZCODE_*; ZCode sets ZCODE_* plus the CLAUDE_* pair, so only Claude Code's
# own markers (CLAUDECODE etc.) may select claude; WorkBuddy also sets
# CODEBUDDY_HOST. WorkBuddy exposes WB_SHT_INSTDIR (install root) and
# WORKBUDDY_APP_PATH (often resources/app.asar, not the exe). An agent with no
# row here — or one whose markers are absent — stays "unknown": the cd chain,
# runtime fallback and model-source probe below all handle that.
agent=unknown
while IFS='|' read -r name vars && [ -n "$name" ]; do
  for marker in $vars; do
    if [ -n "${!marker:-}" ]; then
      case "$name" in
        codebuddy) agent="codebuddy:${CODEBUDDY_HOST:-codebuddy}" ;;
        *) agent=$name ;;
      esac
      break 2
    fi
  done
done <<'EOF'
workbuddy|WORKBUDDY_PRODUCT_NAME WORKBUDDY_APP_PATH WORKBUDDY_IS_PACKAGED WB_SHT_INSTDIR WORKBUDDY_NODE_FALLBACK_EXEC_PATH WORKBUDDY_WINDOWS_APP_INSTALL_DIR WORKBUDDY_APP_INSTALL_DIR WORKBUDDY_PROJECT_DIR
zcode|ZCODE_PROJECT_DIR ZCODE_SESSION_ID ZCODE_NODE_FALLBACK_EXEC_PATH ZCODE_WINDOWS_APP_INSTALL_DIR
claude|CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT
codebuddy|CODEBUDDY_HOST CODEBUDDY_COPILOT_INTERNET_ENVIRONMENT
EOF

# Model source selector for auto-commit-msg.cjs (workbuddy | codebuddy:* |
# zcode | claude | unknown).
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

# --- sensitive-file gate, layer 1 --------------------------------------------
# add -A staged everything, including files that must not be committed. This
# deterministic pass unstages obvious secret files by name (covers new files
# too, since they are already staged at this point); layer 2 below lets the
# helper screen the staged diff with the model. Excluded paths are listed in
# the commit body so the checkpoint stays auditable. GIT_LITERAL_PATHSPECS
# keeps file names with glob metacharacters from matching more than themselves.
sensitive_exclude=""
sensitive_names=$(git diff --cached --name-only 2>/dev/null | grep -iE \
  -e '(^|/)\.env($|\.)' \
  -e '\.(pem|key|p12|pfx|jks|keystore|kdbx)$' \
  -e '(^|/)id_(rsa|dsa|ecdsa|ed25519)($|\.)' \
  -e '(^|/)(credentials?|secrets?)\.(json|ya?ml|toml|ini|txt)$' \
  -e '(^|/)service[-_]?account[-_0-9]*\.json$' \
  -e '(^|/)\.(npmrc|pypirc|netrc)$' \
  | grep -ivE -e '(^|/)\.env\.(example|sample|template|dist|defaults)$' || true)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  GIT_LITERAL_PATHSPECS=1 git reset -q -- "$f" 2>/dev/null || true
  sensitive_exclude="$sensitive_exclude$f"$'\n'
done <<EOF
$sensitive_names
EOF
changed=$(git diff --cached --name-only 2>/dev/null | head -n 200)
file_count=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
[ "$file_count" -gt 0 ] || exit 0  # every staged change was excluded

helper="$script_dir/auto-commit-msg.cjs"

# --- JavaScript runtime -----------------------------------------------------
# Prefer a real Node.js. Desktop agents ship an Electron binary that doubles as
# Node when ELECTRON_RUN_AS_NODE=1, so the hook still works without a standalone
# Node install. The variable is harmless for a real node binary, so it is set
# for every candidate.

to_posix() {
  cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
}

# macOS .app bundles keep their real executable name in Info.plist
# (CFBundleExecutable), and it often differs from the bundle name (e.g.
# "Visual Studio Code.app" ships Contents/MacOS/Code), so resolve it instead
# of guessing. Falls back to the bundle name when the plist cannot be read.
app_exec() {
  local bundle="$1" exe=""
  [ -f "$bundle/Contents/Info.plist" ] || return 1
  if command -v plutil >/dev/null 2>&1; then
    exe=$(plutil -extract CFBundleExecutable raw -o - "$bundle/Contents/Info.plist" 2>/dev/null || true)
  elif command -v defaults >/dev/null 2>&1; then
    exe=$(defaults read "$bundle/Contents/Info" CFBundleExecutable 2>/dev/null || true)
  fi
  [ -n "$exe" ] || exe=$(basename "$bundle" .app)
  [ -f "$bundle/Contents/MacOS/$exe" ] && printf '%s\n' "$bundle/Contents/MacOS/$exe"
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

# Known agent install locations (Windows + macOS app bundles), the agents'
# bundled Node/Electron runtimes, then standalone Node installs. The
# env-derived agent hint decides which host's paths are tried first; no
# process scanning. Candidates that are unset or missing are skipped by
# set_runtime, so the same list serves both platforms.
if [ -z "$runtime" ]; then
  bundled_paths=(
    "${ZCODE_NODE_FALLBACK_EXEC_PATH:-}"
    "${WORKBUDDY_NODE_FALLBACK_EXEC_PATH:-}"
  )
  zcode_paths=(
    "${ZCODE_WINDOWS_APP_INSTALL_DIR:-}/ZCode.exe"
    "${LOCALAPPDATA:-}/Programs/ZCode/ZCode.exe"
    "/c/Program Files/ZCode/ZCode.exe"
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
  for bundle in /Applications/ZCode.app "$HOME/Applications/ZCode.app"; do
    cand_exec=$(app_exec "$bundle") && zcode_paths+=("$cand_exec")
  done
  for bundle in /Applications/WorkBuddy.app "$HOME/Applications/WorkBuddy.app"; do
    cand_exec=$(app_exec "$bundle") && workbuddy_paths+=("$cand_exec")
  done
  for bundle in /Applications/CodeBuddy.app "$HOME/Applications/CodeBuddy.app"; do
    cand_exec=$(app_exec "$bundle") && codebuddy_paths+=("$cand_exec")
  done
  node_paths=(
    "$HOME/scoop/shims/node.exe"
    "$HOME/scoop/apps/nodejs-lts/current/node.exe"
    "$HOME/scoop/apps/nodejs/current/node.exe"
    "/c/Program Files/nodejs/node.exe"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )
  case "$agent" in
    workbuddy)
      agent_paths=("${bundled_paths[@]}" "${workbuddy_paths[@]}" "${codebuddy_paths[@]}" "${zcode_paths[@]}")
      ;;
    codebuddy:*)
      agent_paths=("${bundled_paths[@]}" "${codebuddy_paths[@]}" "${workbuddy_paths[@]}" "${zcode_paths[@]}")
      ;;
    zcode)
      agent_paths=("${bundled_paths[@]}" "${zcode_paths[@]}" "${workbuddy_paths[@]}" "${codebuddy_paths[@]}")
      ;;
    *)
      agent_paths=("${bundled_paths[@]}" "${zcode_paths[@]}" "${workbuddy_paths[@]}" "${codebuddy_paths[@]}")
      ;;
  esac
  for cand in "${agent_paths[@]}" "${node_paths[@]}"; do
    set_runtime "$cand" && break
  done
fi

msgfile=$(mktemp) || exit 0
difffile=$(mktemp) || exit 0
sensitive_out=$(mktemp) || exit 0
# Layer 2 input: the staged diff (HEAD vs index) for the model to screen; the
# shell caps it at 20 KB and the helper clips again. Empty diff (binary-only
# stages) simply skips the content screen.
git diff --cached --no-color --no-textconv --no-ext-diff 2>/dev/null | head -c 20000 > "$difffile" || true
if [ -n "$runtime" ] && [ -f "$helper" ]; then
  printf '%s' "$hook_input" | CHANGED="$changed" DIFF_FILE="$difffile" SENSITIVE_OUT="$sensitive_out" ELECTRON_RUN_AS_NODE=1 "$runtime" "$helper" > "$msgfile" 2>/dev/null
fi
if [ ! -s "$msgfile" ]; then
  if [ "$file_count" -eq 1 ]; then unit=file; else unit=files; fi
  printf 'chore: update %s %s\n' "$file_count" "$unit" > "$msgfile"
fi

# Layer 2 results: unstage what the model flagged (the helper already matched
# every reported path against the staged CHANGED list, so a hallucinated path
# cannot unstage anything), then note every exclusion in the commit body.
while IFS= read -r f; do
  f=$(printf '%s' "$f" | tr -d '\r')
  [ -n "$f" ] || continue
  GIT_LITERAL_PATHSPECS=1 git reset -q -- "$f" 2>/dev/null || true
  sensitive_exclude="$sensitive_exclude$f"$'\n'
done < "$sensitive_out"
if [ -n "$(printf '%s' "$sensitive_exclude" | tr -d '[:space:]')" ]; then
  git diff --cached --quiet && { rm -f "$msgfile" "$difffile" "$sensitive_out"; exit 0; }
  {
    printf '\n'
    printf '%s\n' "⚠ excluded from this commit (sensitive):"
    printf '%s\n' "$sensitive_exclude" | sed '/^$/d; s/^/- /'
  } >> "$msgfile"
fi

git -c commit.gpgsign=false commit -F "$msgfile" --no-verify >/dev/null 2>&1
rm -f "$msgfile" "$difffile" "$sensitive_out"
exit 0
