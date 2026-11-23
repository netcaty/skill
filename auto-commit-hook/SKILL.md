---
name: auto-commit-hook
description: >-
  Install, uninstall, update, inspect, or troubleshoot the automatic git checkpoint
  Stop hook (auto-commit) for ZCode/WorkBuddy/Claude Code workspaces. Use when the
  user asks to enable or disable auto-commit, install, remove, update or upgrade the
  Stop hook or the installed skill, set up per-turn git checkpoints, or diagnose why
  automatic commits are not happening.
  触发词：启用/禁用 自动提交，安装/卸载/更新/升级 hook 或 skill，查看 hook 状态。
---

# Auto-commit hook

This skill installs a `Stop` hook that commits workspace changes once per agent turn.
The hook is a pair of scripts bundled under `hooks/`:

- `auto-commit.sh` — guards, stages changes, commits, records the outcome, and
  always exits 0
- `auto-commit-msg.cjs` — turns the agent's final reply into a Conventional Commits
  subject/body; uses the provider config when available and local heuristics
  otherwise, recording the attempt under `ai` in `last-run.json`

## One-line install

For machines that only have the repository URL (no local checkout):

```bash
curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
```

The script only stages this skill directory to `~/.agents/skills/auto-commit-hook/`
— it does not register any hook. On machines with Claude Code (`~/.claude`
exists or `claude` is on `PATH`) or WorkBuddy (`~/.workbuddy` exists or
`workbuddy` is on `PATH`) it also exposes the staged copy at
`~/.claude/skills/auto-commit-hook/` and/or
`~/.workbuddy/skills/auto-commit-hook/` — a directory junction on Windows, a
symlink on macOS/Linux, falling back to a copy. Claude Code only scans
`~/.claude/skills` and WorkBuddy only scans `~/.workbuddy/skills`; ZCode reads
`~/.agents/skills` directly. Set `AUTOCOMMIT_NO_SKILL_LINK=1` to skip this.
To enable auto-commit afterwards:

```bash
bash ~/.agents/skills/auto-commit-hook/scripts/run.sh install
```

(agent auto-detected from the session environment, user scope by default).
Use a raw.githubusercontent URL; piping the github.com page feeds HTML to bash.

## Quick commands

Run these from anywhere; `scripts/run.sh` locates its own scripts. Every command
accepts `--scope user` (default) or `--scope workspace`. The agent (`zcode`,
`workbuddy` or `claude`) is auto-detected from the session environment the same
way the hook scripts do it, so `--agent` is only needed to override detection
(e.g. installing for WorkBuddy from a ZCode session).

Workspace scope resolves the project from the session environment
(`CLAUDE_PROJECT_DIR`, `ZCODE_PROJECT_DIR`, `CODEBUDDY_PROJECT_DIR`) and falls
back to the current directory, so run workspace-scope commands from the target
repo or pass `--project <dir>`. If the resolved project is the skill directory
itself, the scripts print a warning: `status` reports `not a git repository`
there, an install would register a workspace hook for the skill checkout, and
any `safe.directory` hint it prints would not apply.

`scripts/run.sh` is the entry point: `run.sh <command>` runs
`scripts/<command>.cjs`, so the scripts are its subcommands (`install`,
`uninstall`, `status`, `setup-llm`). The runner finds a Node runtime itself, so
`node` does not have to be on `PATH`: node on `PATH`, `$AUTOCOMMIT_NODE`, the
agent's bundled runtime (`$ZCODE_NODE_FALLBACK_EXEC_PATH` /
`$WORKBUDDY_NODE_FALLBACK_EXEC_PATH`), the app install locations
(`%LOCALAPPDATA%\Programs\{ZCode,WorkBuddy,CodeBuddy}` on Windows;
`/Applications/*.app` on macOS, `~/Applications` probed too, with the executable
read from Info.plist's `CFBundleExecutable` — it may differ from the bundle
name), then standalone Node installs (scoop, `Program Files\nodejs`, Homebrew,
`/usr/local/bin`). Electron binaries are started with `ELECTRON_RUN_AS_NODE=1`
automatically; `.cmd`/`.bat` shims are skipped because bash cannot exec them
directly. `bash scripts/run.sh --print` shows the runtime without running a
command, and `node scripts/<command>.cjs ...` stays equivalent wherever Node is
on `PATH`.

```bash
# Install for every workspace (default scope)
bash scripts/run.sh install

# Install for the current project only
bash scripts/run.sh install --scope workspace

# Install for WorkBuddy (agent auto-detected, or force it with --agent)
bash scripts/run.sh install --agent workbuddy

# Preview without writing
bash scripts/run.sh install --dry-run

# Inspect
bash scripts/run.sh status
bash scripts/run.sh status --agent workbuddy --all --json
bash scripts/run.sh status --doctor          # blockers: bash, git, disable flags, duplicate scopes
bash scripts/run.sh status --update          # drift vs the source checkout

# Uninstall (keep the copied scripts)
bash scripts/run.sh uninstall

# Uninstall and remove copied scripts when nothing else references them
bash scripts/run.sh uninstall --agent workbuddy --scope workspace --purge

# Manual LLM endpoint for commit messages (stored in
# ~/.agents/skills/auto-commit-hook/llm-config.json; wins over the session
# provider, AUTOCOMMIT_LLM_* env overrides win over it)
bash scripts/run.sh setup-llm --url https://example.com/v1/messages --key sk-... --model glm-5.3-flash,auto/glm-5.3-flash
bash scripts/run.sh setup-llm --show
bash scripts/run.sh setup-llm --clear
```

## Update the installed skill

The installed copies live in two places that go stale independently:
`~/.agents/skills/auto-commit-hook/` (staged by `install.sh`; the
`~/.claude/skills` and `~/.workbuddy/skills` links follow it) and the hook
assets `~/.claude/hooks/auto-commit/`, `~/.workbuddy/hooks/auto-commit/` or
`~/.zcode/hooks/auto-commit/` (copied by `install.cjs`). `status --update`
hashes the installed files and reports drift in its `update` section (`--json`
adds an `update` object to every result):

```bash
bash scripts/run.sh status --update
bash scripts/run.sh status --update --source /path/to/skill-checkout   # when no .source.json
```

The source checkout is remembered in
`~/.agents/skills/auto-commit-hook/.source.json` (written by `install.sh` —
local mode records the checkout path, download mode the repo URL), so
`status --update` usually finds it without `--source`. When no local checkout is
recorded, the skill-dir comparison is skipped and the agent falls back to the
download update below.

To refresh (every step is idempotent; the hook registration in the agent
config is untouched):

1. Refresh the skill directory: run `install.sh` from the checkout
   (`bash install.sh` — local mode), or, without a checkout, re-run the
   curl one-liner above (download mode). This also refreshes the agent skill
   links (`~/.claude/skills`, `~/.workbuddy/skills`), which point at the staged
   copy.
2. Refresh the hook assets: `bash scripts/run.sh install`.
3. Re-run `bash scripts/run.sh status --update` and expect `up to date` on both
   lines.

Hook assets take effect on the next Stop event (the hook re-reads its scripts
every turn); updated `SKILL.md`, `references/` and `scripts/` apply to new
sessions.

## Dialog follow-ups

After installing, tell the user the dialog prompts — not raw script commands:
`项目级别启用 hook` applies the hook to the current project only; `禁用 hook`
removes it. When the user types them:

- `项目级别启用 hook`: nothing installed yet → run
  `bash scripts/run.sh install --scope workspace`. If user scope is installed,
  uninstall it first and then install workspace scope — install.cjs refuses
  both scopes at once, and running them together commits twice per turn. If
  workspace scope is already installed, just say so.
- `禁用 hook`: run `bash scripts/run.sh status` first, then uninstall every
  installed scope (`bash scripts/run.sh uninstall`, plus `--scope workspace`
  where needed). Keep the copied scripts unless the user asks for `--purge`.
- `更新 hook` (or `更新 skill`): run `bash scripts/run.sh status --update` first
  — its `update` section names the stale files. Then refresh the skill directory
  (checkout: `bash install.sh` there; no checkout: re-run the curl one-liner),
  run `bash scripts/run.sh install`, and re-run `status --update` to verify. Say
  that hook assets apply immediately while SKILL.md changes need a new session.
- `查看 hook 状态`: run `bash scripts/run.sh status --all` (add `--json` when the
  result is parsed programmatically). Report installed/enabled per scope. Add
  `--update` when the user also asks about outdated files, and `--doctor` for
  blockers (missing bash, Claude disable flags, git ownership, both scopes
  installed). A `last run: ok` line is healthy; `last run: FAILED
  <time> (<stage>)` names the failing step and the log path under the install
  directory, so quote it back to the user and suggest the fix. The `ai:` line
  explains a heuristic commit message — `disabled`, `skipped`, `unavailable`
  (checked sources) or `error` (per-model failures) — and is diagnostics only,
  not a failed commit.
- `设置 LLM 配置[: url=... key=... model=...]`: run
  `bash scripts/run.sh setup-llm --url <url> --key <key> [--model <id[,id...]>]`;
  ask for any missing values first. After saving, confirm with `--show`
  (key masked) and never echo the key in plain text. `查看 LLM 配置` runs
  `--show`, `清除 LLM 配置` runs `--clear`. The saved config outranks the
  session provider — say so when saving.

## Verify

```bash
bash scripts/run.sh status --scope workspace
```

Expect `installed` and `scripts: present`, and after a turn `last run: ok ...`.
The companion `ai:` line says how the message was produced (an `unavailable`
or `error` value explains a heuristic-only message without failing the run).
`enabled: true` appears for ZCode only (command-string agents report
`enabled: (n/a for command hooks)`). Add `--doctor` to check the configured
bash, Claude disable flags, git usability (a `safe.directory` fix is suggested
only for the ownership case), and duplicate scope installs. A
`last run: FAILED ...` line names the failing stage and the log path; see
[troubleshooting](references/troubleshooting.md), which also shows how to run
the installed hook by hand.

- New sessions pick up the hook. Start a new session or reopen the workspace after
  installing.

## Uninstall

`uninstall.cjs` removes only entries whose script is `auto-commit.sh`, preserves all
other hooks, restores the `hooks.enabled` value recorded at install, and deletes the
config file only if the installer created it and nothing else remains. `--purge`
removes the copied scripts and install state when no remaining config references
them (the `backups/` directory is kept).

## Safety

- The hook runs `git add -A` every turn: all tracked/untracked, non-ignored
  changes are committed, including pre-existing user changes.
- Sensitive files get a two-layer gate before the commit (obvious secret names
  are unstaged by name; a model screens a clipped diff and can flag more), and
  every exclusion is listed in the commit body. This is not a security
  boundary.
- It uses `--no-verify`, skips merge/rebase/conflict/detached-HEAD states,
  serializes concurrent Stops on `<git-dir>/auto-commit.lock`, and skips
  `stop_hook_active: true` re-entries.

The full list — Claude Code's merged hook files, `disableAllHooks`, workspace
trust, scope defaults and `.gitignore` caveats — is in
[safety](references/safety.md).

## Reference files

- [install internals](references/install-internals.md) — what install writes,
  config paths, hook JSON per agent, commit-message model sources
- [troubleshooting](references/troubleshooting.md) — failure reporting, manual
  hook runs, common problems
- [safety](references/safety.md) — complete safety behaviour
- [adding an agent](references/adding-an-agent.md) — support checklist for a new
  host
