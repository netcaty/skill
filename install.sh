#!/usr/bin/env bash
# Skill bootstrap for the auto-commit-hook skill repository.
#
# Two ways to run this installer — both stage the skill directory to
# ~/.agents/skills/auto-commit-hook/ and register NOTHING:
#
# 1. curl (no git needed; a raw URL — piping the github.com page feeds HTML
#    to bash):
#      curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
#
# 2. git clone (the script detects the checkout next to itself and copies the
#    local auto-commit-hook/ folder):
#      git clone https://github.com/netcaty/skill
#      ./skill/install.sh
#
# To enable auto-commit afterwards (this script does not do it):
#   node ~/.agents/skills/auto-commit-hook/scripts/install.cjs
# (agent auto-detected from the session environment, user scope by default;
# see auto-commit-hook/SKILL.md for --agent/--scope/--config options)
#
# Env overrides (mainly for testing):
#   AUTOCOMMIT_INSTALL_RAW    base URL files are fetched from (download mode)
#   AUTOCOMMIT_INSTALL_DIR    where the skill directory is staged
#   AUTOCOMMIT_INSTALL_MODE   force local|download
set -euo pipefail

# Git-Bash launchers may start with a Windows-only PATH; coreutils (dirname,
# mkdir, cygpath) live in /usr/bin, so add it when it is not already present.
case ":$PATH:" in
  *:/usr/bin:*) ;;
  *) [ -d /usr/bin ] && PATH="/usr/bin:/bin:$PATH" ;;
esac

REPO="netcaty/skill"
BRANCH="main"
RAW="${AUTOCOMMIT_INSTALL_RAW:-https://raw.githubusercontent.com/$REPO/$BRANCH}"
SKILL_DIR="${AUTOCOMMIT_INSTALL_DIR:-$HOME/.agents/skills/auto-commit-hook}"

log() { printf '[auto-commit] %s\n' "$*"; }
fail() { printf '[auto-commit] %s\n' "$*" >&2; exit 1; }

# Resolve this script before staging: $0 may be relative, and when piped via
# curl|bash it is not a file at all (then download mode is used).
script_path=$0
case "$script_path" in
  */*) ;;
  *) script_path=$(command -v "$script_path" 2>/dev/null || printf '%s' "$script_path") ;;
esac
if command -v cygpath >/dev/null 2>&1; then
  script_path=$(cygpath -u "$script_path" 2>/dev/null || printf '%s' "$script_path")
fi
script_dir=$(cd "$(dirname "$script_path")" 2>/dev/null && pwd || printf '')

if [ -n "$script_dir" ] && [ -f "$script_dir/auto-commit-hook/SKILL.md" ]; then
  MODE=local
else
  MODE=download
fi
MODE="${AUTOCOMMIT_INSTALL_MODE:-$MODE}"

log "installing skill to $SKILL_DIR ($MODE mode)"
mkdir -p "$SKILL_DIR"

if [ "$MODE" = local ]; then
  # Run from a git clone (or any checkout): copy the sibling skill folder.
  cp -R "$script_dir/auto-commit-hook/." "$SKILL_DIR/"
else
  command -v curl >/dev/null 2>&1 \
    || fail "curl not found; install curl or use the git clone method."
  BASE="$RAW/auto-commit-hook"
  log "fetching skill files from $BASE"
  FILES="SKILL.md hooks/auto-commit.sh hooks/auto-commit-msg.cjs scripts/lib.cjs scripts/install.cjs scripts/uninstall.cjs scripts/status.cjs scripts/setup-llm.cjs"
  for f in $FILES; do
    mkdir -p "$SKILL_DIR/$(dirname "$f")"
    curl -fsSL "$BASE/$f" -o "$SKILL_DIR/$f" || fail "download failed: $BASE/$f"
    [ -s "$SKILL_DIR/$f" ] || fail "empty download: $f"
  done
fi

log "skill directory: $SKILL_DIR"
log "Hook not registered. To enable auto-commit later, run:"
log "  node \"$SKILL_DIR/scripts/install.cjs\""
log "  or type '安装 hook' in the agent's dialog box."
