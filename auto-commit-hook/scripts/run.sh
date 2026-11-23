#!/usr/bin/env bash
# Runner for this skill's Node scripts, which are its subcommands:
#
#   bash scripts/run.sh install --scope workspace
#   bash scripts/run.sh status --all
#   bash scripts/run.sh uninstall --purge
#   bash scripts/run.sh setup-llm --show
#   bash scripts/run.sh --print        # print the runtime, run nothing
#
# `<command>` maps to `scripts/<command>.cjs`; a relative path or a name ending
# in .cjs is accepted too. The runner finds a Node runtime itself, so `node`
# does not have to be on PATH: node on PATH, $AUTOCOMMIT_NODE, the host agent's
# bundled runtime ($ZCODE_NODE_FALLBACK_EXEC_PATH /
# $WORKBUDDY_NODE_FALLBACK_EXEC_PATH), the agents' usual install locations
# (Windows %LOCALAPPDATA%\Programs\{ZCode,WorkBuddy,CodeBuddy}, macOS
# /Applications/*.app bundles), then standalone Node installs. Desktop agents
# ship Electron, which doubles as Node when ELECTRON_RUN_AS_NODE=1 is set; the
# variable is exported for every candidate, so a real node binary is unaffected.
#
# The discovery list mirrors the JavaScript-runtime block in
# hooks/auto-commit.sh; keep the two in sync when an agent moves its install.
set -u

# Git-Bash launchers may start with a Windows-only PATH; coreutils, cygpath and
# dirname live in /usr/bin.
case ":$PATH:" in
  *:/usr/bin:*) ;;
  *) [ -d /usr/bin ] && PATH="/usr/bin:/bin:$PATH" ;;
esac

script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd) || {
  printf 'run.sh: cannot resolve its own directory\n' >&2
  exit 1
}

list_commands() {
  local f names=""
  for f in "$script_dir"/*.cjs; do
    [ -f "$f" ] || continue
    f=${f##*/}
    [ "$f" = "lib.cjs" ] && continue   # shared library, not a command
    names="$names ${f%.cjs}"
  done
  printf '%s\n' "${names# }"
}

usage() {
  printf 'usage: run.sh <command> [args...]   |   run.sh --print\n' >&2
  printf 'commands: %s\n' "$(list_commands)" >&2
  printf 'example: run.sh status --all\n' >&2
}

print_only=0
case "${1:-}" in
  --print) print_only=1; shift ;;
  -h|--help|help)
    printf 'usage: run.sh <command> [args...]   |   run.sh --print\n'
    printf 'commands: %s\n' "$(list_commands)"
    printf '\n<command> runs scripts/<command>.cjs with a discovered Node runtime\n'
    printf '(node on PATH, $AUTOCOMMIT_NODE, or the agent app executable started\n'
    printf 'with ELECTRON_RUN_AS_NODE=1). --print shows that runtime.\n'
    exit 0
    ;;
esac

if [ $# -lt 1 ]; then
  [ "$print_only" -eq 1 ] || { usage; exit 2; }
  target=""
else
  target=$1
  shift
fi

script=""
if [ -n "$target" ]; then
  case "$target" in
    */*) script=$target ;;
    *.cjs) script="$script_dir/$target" ;;
    *) script="$script_dir/$target.cjs" ;;
  esac
  if [ ! -f "$script" ]; then
    printf 'run.sh: unknown command: %s\n' "$target" >&2
    printf 'commands: %s\n' "$(list_commands)" >&2
    exit 2
  fi
  case "${script##*/}" in
    lib.cjs)
      printf 'run.sh: %s is a shared library, not a command\n' "$target" >&2
      printf 'commands: %s\n' "$(list_commands)" >&2
      exit 2
      ;;
  esac
fi

# Process hooks and agents pass Windows paths on Windows; dirname/tests want the
# POSIX form.
to_posix() {
  cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
}

runtime=""
try_runtime() {
  local cand
  [ -n "${1:-}" ] || return 1
  case "$1" in *.cmd|*.bat) return 1 ;; esac   # bash cannot exec these directly
  cand=$(to_posix "$1")
  [ -f "$cand" ] && [ -x "$cand" ] || return 1
  runtime=$cand
}

# macOS .app bundles keep the real executable name in Info.plist
# (CFBundleExecutable), which often differs from the bundle name (e.g.
# "Visual Studio Code.app" ships Contents/MacOS/Code).
app_exec() {
  local bundle=$1 exe=""
  [ -f "$bundle/Contents/Info.plist" ] || return 1
  if command -v plutil >/dev/null 2>&1; then
    exe=$(plutil -extract CFBundleExecutable raw -o - "$bundle/Contents/Info.plist" 2>/dev/null || true)
  elif command -v defaults >/dev/null 2>&1; then
    exe=$(defaults read "$bundle/Contents/Info" CFBundleExecutable 2>/dev/null || true)
  fi
  [ -n "$exe" ] || exe=$(basename "$bundle" .app)
  [ -f "$bundle/Contents/MacOS/$exe" ] && printf '%s\n' "$bundle/Contents/MacOS/$exe"
}

# A real Node.js first — it is the cheapest and most predictable runtime.
try_runtime "$(command -v node 2>/dev/null || true)"
# Explicit override for tests or unusual installs.
[ -n "$runtime" ] || try_runtime "${AUTOCOMMIT_NODE:-}"

if [ -z "$runtime" ]; then
  candidates=(
    "${ZCODE_NODE_FALLBACK_EXEC_PATH:-}"
    "${WORKBUDDY_NODE_FALLBACK_EXEC_PATH:-}"
    "${ZCODE_WINDOWS_APP_INSTALL_DIR:-}/ZCode.exe"
    "${WB_SHT_INSTDIR:-}/WorkBuddy.exe"
    "${LOCALAPPDATA:-}/Programs/ZCode/ZCode.exe"
    "${LOCALAPPDATA:-}/Programs/WorkBuddy/WorkBuddy.exe"
    "${LOCALAPPDATA:-}/Programs/CodeBuddy/CodeBuddy.exe"
    "/c/Program Files/ZCode/ZCode.exe"
    "/c/Program Files/WorkBuddy/WorkBuddy.exe"
    "/c/Program Files (x86)/WorkBuddy/WorkBuddy.exe"
    "$HOME/scoop/shims/node.exe"
    "$HOME/scoop/apps/nodejs-lts/current/node.exe"
    "$HOME/scoop/apps/nodejs/current/node.exe"
    "/c/Program Files/nodejs/node.exe"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )
  for bundle in /Applications/ZCode.app "$HOME/Applications/ZCode.app"; do
    exe=$(app_exec "$bundle") && candidates+=("$exe")
  done
  for bundle in /Applications/WorkBuddy.app "$HOME/Applications/WorkBuddy.app"; do
    exe=$(app_exec "$bundle") && candidates+=("$exe")
  done
  for bundle in /Applications/CodeBuddy.app "$HOME/Applications/CodeBuddy.app"; do
    exe=$(app_exec "$bundle") && candidates+=("$exe")
  done
  for cand in "${candidates[@]}"; do
    try_runtime "$cand" && break
  done
fi

if [ -z "$runtime" ]; then
  printf 'run.sh: no Node runtime found.\n' >&2
  printf 'Install Node, or point AUTOCOMMIT_NODE at the agent app executable\n' >&2
  printf '(ZCode.exe / WorkBuddy.exe / CodeBuddy.exe — Electron runs as Node).\n' >&2
  exit 127
fi

if [ "$print_only" -eq 1 ]; then
  printf '%s\n' "$runtime"
  exit 0
fi
if [ -z "$script" ]; then
  usage
  exit 2
fi

ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$script" "$@"
