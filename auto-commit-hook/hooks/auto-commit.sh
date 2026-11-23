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
# helper may flag more from the staged diff (layer 2); every excluded path is
# listed in the commit body. A path that cannot be unstaged aborts the commit
# instead of being committed.
# Failures: the hook always exits 0, but real failures (git add/commit, the
# sensitive gate, missing git) update last-run.json and append to a lazily
# created, bounded auto-commit.log under the state directory, and status.cjs
# prints the last outcome. Claude Code also gets a non-blocking systemMessage
# JSON on stdout; AUTOCOMMIT_NOTIFY_STDOUT=1/0 forces that channel on/off for
# other hosts.
# Nothing else is written to stdout: hook stdout is parsed as strict JSON, and
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

# --- Failure visibility ------------------------------------------------------
# The hook must never block the turn, so it always exits 0. Real failures are
# still made visible: the last outcome lands in last-run.json and a bounded
# auto-commit.log, status.cjs prints them, and Claude Code (whose Stop hook
# accepts {"systemMessage":...} on stdout) gets an immediate UI message.
# AUTOCOMMIT_STATE_DIR is a test/debug override; installed hooks use their own
# asset directory.
state_dir=${AUTOCOMMIT_STATE_DIR:-$script_dir}
if ! mkdir -p "$state_dir" 2>/dev/null; then
  state_dir=$script_dir
fi
state_file="$state_dir/last-run.json"
log_file="$state_dir/auto-commit.log"

# Sanitize git output for a JSON string: collapse control characters, cap the
# length, then escape backslashes and quotes.
json_escape() {
  printf '%s' "$1" \
    | tr '\r\n\t' '   ' \
    | tr -d '\001-\010\013\014\016-\037' \
    | cut -c1-500 \
    | sed 's/\\/\\\\/g; s/"/\\"/g'
}

notify_stdout=0
case "$agent" in
  claude) notify_stdout=1 ;;
esac
case "${AUTOCOMMIT_NOTIFY_STDOUT:-}" in
  1) notify_stdout=1 ;;
  0) notify_stdout=0 ;;
esac

record_run() {
  local status=$1 stage=${2:-} detail=${3:-} json ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date 2>/dev/null || true)
  if [ "$status" = "ok" ]; then
    json=$(printf '{"at":"%s","status":"ok","agent":"%s"}' "$ts" "$agent")
  else
    json=$(printf '{"at":"%s","status":"error","agent":"%s","stage":"%s","detail":"%s"}' \
      "$ts" "$agent" "$(json_escape "$stage")" "$(json_escape "$detail")")
  fi
  printf '%s\n' "$json" > "$state_file.tmp.$$" 2>/dev/null \
    && mv -f "$state_file.tmp.$$" "$state_file" 2>/dev/null || true
}

report_failure() {
  local stage=$1 detail=$2 ts msg
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date 2>/dev/null || true)
  msg=$(json_escape "$detail")
  printf '%s [%s] %s: %s\n' "$ts" "$agent" "$stage" "$msg" >> "$log_file" 2>/dev/null || true
  if [ -f "$log_file" ]; then
    tail -n 200 "$log_file" > "$log_file.tmp.$$" 2>/dev/null \
      && mv -f "$log_file.tmp.$$" "$log_file" 2>/dev/null || true
  fi
  record_run error "$stage" "$detail"
  if [ "$notify_stdout" = "1" ]; then
    printf '{"systemMessage":"%s","suppressOutput":true}\n' \
      "$(json_escape "⚠ auto-commit failed ($stage): $detail")"
  fi
}

report_success() {
  record_run ok
}

# A missing git binary is a real failure. "Not a git work tree" is an expected
# skip: user-scope hooks also run in projects that are not repositories.
if ! command -v git >/dev/null 2>&1; then
  report_failure "git" "git not found on PATH"
  exit 0
fi

project_dir="${ZCODE_PROJECT_DIR:-${WORKBUDDY_PROJECT_DIR:-${CODEBUDDY_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}}}"
if ! cd "$project_dir" >/dev/null 2>&1; then
  report_failure "project directory" "cannot enter $project_dir"
  exit 0
fi
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

add_output=$(git add -A 2>&1)
add_status=$?
if [ "$add_status" -ne 0 ]; then
  # A parallel git process can hold index.lock briefly; retry once before
  # treating the stage step as a real failure.
  sleep 0.5 2>/dev/null || sleep 1
  add_output=$(git add -A 2>&1)
  add_status=$?
fi
if [ "$add_status" -ne 0 ]; then
  report_failure "git add" "$add_output"
  exit 0
fi
# git diff --quiet exits 0 for "no staged changes" and 1 for "changes staged";
# anything above 1 is an error worth reporting.
diff_output=$(git diff --cached --quiet 2>&1)
diff_status=$?
[ "$diff_status" -eq 0 ] && exit 0  # nothing stageable changed
if [ "$diff_status" -gt 1 ]; then
  report_failure "git diff --cached" "exit $diff_status: $diff_output"
  exit 0
fi

# --- sensitive-file gate, layer 1 --------------------------------------------
# add -A staged everything, including files that must not be committed. This
# deterministic pass unstages obvious secret files by name (covers new files
# too, since they are already staged at this point); layer 2 below lets the
# helper screen the staged diff with the model. Excluded paths are listed in
# the commit body so the checkpoint stays auditable. GIT_LITERAL_PATHSPECS
# keeps file names with glob metacharacters from matching more than themselves.
sensitive_exclude=""
gate_failed=""
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
  if ! GIT_LITERAL_PATHSPECS=1 git reset -q -- "$f" 2>/dev/null; then
    gate_failed="$gate_failed$f"$'\n'
    continue
  fi
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

msgfile=$(mktemp) || { report_failure "temp file" "cannot create a temporary file"; exit 0; }
difffile=$(mktemp) || { report_failure "temp file" "cannot create a temporary file"; rm -f "$msgfile"; exit 0; }
sensitive_out=$(mktemp) || { report_failure "temp file" "cannot create a temporary file"; rm -f "$msgfile" "$difffile"; exit 0; }
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
  if ! GIT_LITERAL_PATHSPECS=1 git reset -q -- "$f" 2>/dev/null; then
    gate_failed="$gate_failed$f"$'\n'
    continue
  fi
  sensitive_exclude="$sensitive_exclude$f"$'\n'
done < "$sensitive_out"
# If the sensitive gate cannot unstage a flagged path, committing anyway would
# leak it. Abort, unstage everything, and surface the failure instead.
if [ -n "$gate_failed" ]; then
  report_failure "sensitive gate" "could not unstage: $(printf '%s' "$gate_failed" | tr '\n' ' ')"
  git reset -q >/dev/null 2>&1 || true
  rm -f "$msgfile" "$difffile" "$sensitive_out"
  exit 0
fi
if [ -n "$(printf '%s' "$sensitive_exclude" | tr -d '[:space:]')" ]; then
  git diff --cached --quiet && { rm -f "$msgfile" "$difffile" "$sensitive_out"; exit 0; }
  {
    printf '\n'
    printf '%s\n' "⚠ excluded from this commit (sensitive):"
    printf '%s\n' "$sensitive_exclude" | sed '/^$/d; s/^/- /'
  } >> "$msgfile"
fi

commit_output=$(git -c commit.gpgsign=false commit -F "$msgfile" --no-verify 2>&1)
commit_status=$?
if [ "$commit_status" -eq 0 ]; then
  report_success
else
  case "$commit_output" in
    *"nothing to commit"*|*"nothing added to commit"*|*"no changes added to commit"*)
      : ;;  # a parallel hook invocation already committed this turn
    *)
      report_failure "git commit" "$commit_output"
      ;;
  esac
fi
rm -f "$msgfile" "$difffile" "$sensitive_out"
exit 0
