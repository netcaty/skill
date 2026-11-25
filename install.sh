#!/usr/bin/env bash
# Skill bootstrap for the auto-commit-hook skill repository.
#
# Two ways to run this installer — both stage the skill directory to
# ~/.agents/skills/auto-commit-hook/ and register NOTHING:
#
# 1. curl (no git needed; curl + tar, and use a raw URL — piping the
#    github.com page feeds HTML to bash):
#      curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
#
# 2. git clone (the script detects the checkout next to itself and copies the
#    local auto-commit-hook/ folder):
#      git clone https://github.com/netcaty/skill
#      ./skill/install.sh
#
# To enable auto-commit afterwards (this script does not do it):
#   bash ~/.agents/skills/auto-commit-hook/scripts/run.sh install
# (agent auto-detected from the session environment, user scope by default;
# see auto-commit-hook/SKILL.md for --agent/--scope/--config options)
#
# On machines with Claude Code (~/.claude exists or `claude` is on PATH) or
# WorkBuddy (~/.workbuddy exists or `workbuddy` is on PATH) the staged skill is
# also exposed at ~/.claude/skills/auto-commit-hook and/or
# ~/.workbuddy/skills/auto-commit-hook, because those hosts only scan their own
# skills dirs (ZCode reads ~/.agents/skills directly). Set
# AUTOCOMMIT_NO_SKILL_LINK=1 to skip that.
#
# Env overrides (mainly for testing):
#   AUTOCOMMIT_INSTALL_ARCHIVE tarball URL for download mode
#   AUTOCOMMIT_INSTALL_DIR     where the skill directory is staged
#   AUTOCOMMIT_INSTALL_MODE    force local|download
set -euo pipefail

# Git-Bash launchers may start with a Windows-only PATH; coreutils (dirname,
# mkdir, cygpath) live in /usr/bin, so add it when it is not already present.
case ":$PATH:" in
  *:/usr/bin:*) ;;
  *) [ -d /usr/bin ] && PATH="/usr/bin:/bin:$PATH" ;;
esac

REPO="netcaty/skill"
BRANCH="main"
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
  command -v tar >/dev/null 2>&1 \
    || fail "tar not found; install tar or use the git clone method."

  # One request for the repository tarball; it carries every shipped file, so
  # there is no per-file list to maintain. GitHub archives nest everything
  # under a single top-level <repo>-<ref> directory.
  ARCHIVE="${AUTOCOMMIT_INSTALL_ARCHIVE:-https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz}"
  TMP=$(mktemp -d 2>/dev/null) || fail "mktemp failed"
  # A native coreutils build earlier on PATH (e.g. scoop) makes mktemp return a
  # Windows path (C:\Users\...\Temp\tmp.x). Git Bash's GNU tar cannot chdir
  # into the backslash form ("Cannot open: No such file or directory"), so
  # normalize it to POSIX; cygpath does not exist on macOS/Linux.
  if command -v cygpath >/dev/null 2>&1; then
    TMP=$(cygpath -u "$TMP" 2>/dev/null || printf '%s' "$TMP")
  fi
  log "fetching $ARCHIVE"
  if ! curl -fsSL --connect-timeout 10 --max-time 120 "$ARCHIVE" 2>/dev/null \
    | tar -xz -C "$TMP" 2>/dev/null; then
    rm -rf "$TMP"
    fail "download failed: $ARCHIVE (check the network/proxy, use the git clone method, or set AUTOCOMMIT_INSTALL_ARCHIVE)"
  fi
  TOP=""
  for d in "$TMP"/*/; do
    [ -d "$d" ] || continue
    TOP=${d%/}
    break
  done
  if [ -z "$TOP" ] || [ ! -f "$TOP/auto-commit-hook/SKILL.md" ]; then
    rm -rf "$TMP"
    fail "unexpected archive layout: auto-commit-hook/SKILL.md not found"
  fi
  cp -R "$TOP/auto-commit-hook/." "$SKILL_DIR/"
  rm -rf "$TMP"
fi

# Record where future updates should come from. status.cjs reads this file to
# find the source checkout when checking the installed copies for drift.
# cygpath -m keeps the JSON valid on Windows (forward slashes, still accepted
# by node's path functions).
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$MODE" = local ]; then
  if command -v cygpath >/dev/null 2>&1; then
    source_native=$(cygpath -m "$script_dir")
  else
    source_native=$script_dir
  fi
  printf '{\n  "source": "%s",\n  "mode": "local",\n  "installedAt": "%s"\n}\n' \
    "$source_native" "$installed_at" > "$SKILL_DIR/.source.json"
else
  printf '{\n  "source": "https://github.com/%s",\n  "mode": "download",\n  "installedAt": "%s"\n}\n' \
    "$REPO" "$installed_at" > "$SKILL_DIR/.source.json"
fi

# --- Agent skill discoverability ---------------------------------------------
# ZCode reads ~/.agents/skills directly, but Claude Code only scans
# ~/.claude/skills and WorkBuddy only scans ~/.workbuddy/skills. Expose the
# staged copy in each agent home that is present: a directory junction on
# Windows (no admin required), a symlink on macOS/Linux, and a plain copy as the
# last resort. Links point at the staged skill dir, so re-running this script
# refreshes the contents automatically.
ensure_agent_skill_link() {
  local agent_home=$1 agent_label=$2 agent_cli=$3
  local link="$agent_home/skills/auto-commit-hook"
  local target
  target=$(cd "$SKILL_DIR" 2>/dev/null && pwd -P) || return 0

  # A custom install dir already inside this agent's skills tree needs no link.
  case "$target" in
    "$agent_home"/skills/*) return 0 ;;
  esac

  if [ ! -d "$agent_home" ] && ! command -v "$agent_cli" >/dev/null 2>&1; then
    return 0
  fi

  # Never replace an existing entry: it may be a real directory the user owns.
  if [ -e "$link" ] || [ -L "$link" ]; then
    if [ -f "$link/SKILL.md" ]; then
      log "$agent_label skill already available: $link"
    else
      log "warning: $link exists but does not resolve to a skill; leaving it untouched"
    fi
    return 0
  fi

  mkdir -p "$agent_home/skills" 2>/dev/null || true

  local linked=0
  if command -v cygpath >/dev/null 2>&1 && command -v cmd >/dev/null 2>&1; then
    cmd //c mklink //J "$(cygpath -w "$link")" "$(cygpath -w "$target")" >/dev/null 2>&1 && linked=1
  fi
  if [ "$linked" -eq 0 ]; then
    ln -s "$target" "$link" 2>/dev/null && linked=1
  fi
  if [ "$linked" -eq 0 ]; then
    if mkdir -p "$link" 2>/dev/null && cp -R "$target/." "$link/" 2>/dev/null; then
      linked=1
      log "copied skill to $link (re-run this script after updates)"
    else
      rmdir "$link" 2>/dev/null || true
    fi
  fi

  if [ "$linked" -eq 1 ] && [ -f "$link/SKILL.md" ]; then
    log "$agent_label skill: $link"
  else
    log "warning: could not expose the skill to $agent_label at $link"
  fi
}

if [ -z "${AUTOCOMMIT_NO_SKILL_LINK:-}" ]; then
  ensure_agent_skill_link "$HOME/.claude" "Claude Code" claude
  ensure_agent_skill_link "$HOME/.workbuddy" "WorkBuddy" workbuddy
fi

log "skill directory: $SKILL_DIR"
log "Hook not registered. To enable auto-commit later, run:"
log "  bash \"$SKILL_DIR/scripts/run.sh\" install"
log "  or type '安装 hook' in the agent's dialog box."
log "To update later, re-run this script (or type '更新 hook' in the agent's dialog box)."
