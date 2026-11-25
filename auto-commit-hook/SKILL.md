---
name: auto-commit-hook
description: >-
  Install, uninstall, update, inspect, pause, resume, or troubleshoot the
  automatic git checkpoint Stop hook (auto-commit) for agent workspaces. Use
  when the user asks to enable or disable auto-commit, install, remove, update
  or upgrade the Stop hook or the installed skill, set up per-turn git
  checkpoints, configure the model that writes commit messages, or diagnose why
  automatic commits are not happening.
  Trigger phrases: enable / pause / resume / disable auto-commit; install,
  uninstall, update, or upgrade the hook or skill; view hook status; set,
  show, or clear the hook config (config.json).
---

# Auto-commit hook

Commits workspace changes once per agent turn through a `Stop` hook. Each commit
gets a Conventional Commits subject and an AI-written body; when no model
produces a usable draft the message is a deterministic file list
(`chore: update ...`). Obvious sensitive files are
excluded, and the hook always exits 0 — it never blocks or fails a turn.

## Before you act

Check live state instead of reciting from this file:

```bash
bash scripts/run.sh status --all
```

**Do not read or analyze the scripts under `hooks/` or `scripts/`.** Answer from
this document and the commands' printed output, and run the documented command
rather than tracing the code. Source review is only for maintaining the skill.

- Run `status --doctor` before explaining why commits are missing.
- Run `status --update` before saying whether installed files are current.
- Read the matching [reference file](#reference-files) before explaining
  internals or safety.

A paused hook or a stale copy is fixed by `enable` or an update, not by a
reinstall.

## Prerequisites and placeholders

Requires `git` and `bash` (Git Bash on Windows); `run.sh` discovers Node
automatically, even when it is not on `PATH`. Optional environment overrides are
in [environment](references/environment.md).

- `<skill-dir>` — installed skill directory (`$AUTOCOMMIT_INSTALL_DIR`, default
  `~/.agents/skills/auto-commit-hook`)
- `<agent>` — detected host profile id printed by `status` and accepted by
  `--agent`

## Install

### The skill (no local checkout)

```bash
curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
```

The script stages the skill at `<skill-dir>` and registers no hook.

### The hook

```bash
bash scripts/run.sh install
```

Run `bash <skill-dir>/scripts/run.sh <command>` from any directory (or
`bash scripts/run.sh <command>` inside a checkout).

- `--scope user` (default) applies to every project; `--scope workspace` limits
  the hook to one repo (resolved from the session project or cwd; override with
  `--project <dir>`).
- `--agent <agent>` overrides host auto-detection, e.g. to install for another
  host from inside a session.
- `--config <file>` and `--timeout <ms>` override the config path and hook
  timeout (default 30000 ms); `--dry-run` previews without writing.
- Installing both scopes commits twice per turn and is refused unless `--force`.

## Status and diagnostics

```bash
bash scripts/run.sh status                  # current scope
bash scripts/run.sh status --all            # user + workspace
bash scripts/run.sh status --all --json     # machine-readable
bash scripts/run.sh status --doctor         # runtime blockers
bash scripts/run.sh status --update         # drift vs the source
```

For a failed run or running the installed hook by hand, see
[troubleshooting](references/troubleshooting.md).

## Pause and resume

```bash
bash scripts/run.sh disable
bash scripts/run.sh enable
```

Temporary pause without touching the host config: commits stop from the next
Stop (`install` preserves a pause; `uninstall` clears it).

## Update the installed skill

Two copies refresh independently: the skill directory and the hook assets.
`status --update` reports drift against the source checkout.

```bash
bash scripts/run.sh status --update
bash scripts/run.sh status --update --source /path/to/skill-checkout   # if none was recorded
```

Refresh — every step is idempotent and leaves the hook registration intact:

1. Refresh the skill directory: run `bash install.sh` from the checkout, or
   re-run the curl one-liner without one.
2. Refresh the hook assets: `bash scripts/run.sh install`.
3. Re-run `bash scripts/run.sh status --update` to confirm `up to date` on both
   lines.

## Uninstall

```bash
bash scripts/run.sh uninstall
bash scripts/run.sh uninstall --agent <agent> --scope workspace --purge
```

Removes only auto-commit entries and cleans up a config file it created; use
`disable` for a temporary pause. `--purge` also removes copied scripts when
unreferenced (`backups/` is kept).

## Hook config

Messages use the host's session provider by default; on Claude Code without a
provider or saved endpoint, the local `claude` CLI login (`haiku`) is used.
`<skill-dir>/config.json` stores an optional manual endpoint and runtime
settings — see [environment](references/environment.md) for keys, defaults, and
priority.

**Never ask or allow the user to manually edit `<skill-dir>/config.json`** (do
not point them to edit the file by hand or provide JSON for manual editing);
`bash scripts/run.sh config` is its sole writer.

```bash
bash scripts/run.sh config --show            # effective values and sources; key masked
bash scripts/run.sh config --set <key>=<value>
bash scripts/run.sh config --unset <key>
bash scripts/run.sh config --clear
```

- Run `--show`, `--set`, `--unset`, and `--clear` yourself for inspection and
  non-secret settings (`noAi`, `noAiScreen`, `claudeBin`, `aiTimeoutMs`,
  `aiTotalMs`, `sourceDir`).
- Never ask for, accept, or print an API key in chat, never guess or
  reconstruct a masked key printed by `--show`, and never pass a key in a
  command you run. If the user needs a manual endpoint (`url`/`key`/`model`),
  have them set `AUTOCOMMIT_LLM_*` environment variables or run
  `bash <skill-dir>/scripts/run.sh config --url <url> --key <key> --model <models>`
  themselves outside chat — never by hand-editing `config.json`.
- Whenever a saved manual endpoint is involved, mention that it outranks the
  host's session provider; environment variables still win per key.
- When `--show` reports `(session provider)` for `url`/`key`/`model`, or
  `--clear` prints `Cleared <file>`, say the host's session provider is used.
- When `ai` shows `transport: cli`, say the message came from the local Claude
  Code login state; if it says `Not logged in`, the commit still succeeded with
  the file-list placeholder and retries automatically once the user logs in
  again.

## What to tell the user

Report in the user's terms — scope, whether the registration was kept, and when
a change takes effect. **Run every command yourself; never ask the user to
execute one manually.** Ground every report in the lines the command just
printed; never claim a state `status` has not shown. If a command exits
non-zero, quote its `Error:` line and the fix it names before suggesting
anything else.

### After install

- Always name the scope (`user` covers every project; `workspace` only the
  resolved repo) and the config file written. Say a new session (or reopening
  the workspace) picks up the registration.
- With the hook enabled, summarize [Safety](#safety): every turn commits all
  non-ignored changes (including pre-existing ones), the sensitive-file gate
  is not a security boundary, and `.gitignore` should be reviewed first.
- When `paused : yes` appears, say the hook stays paused and `恢复 hook`
  resumes it without a reinstall.
- When `backup :` appears, quote the path only if the user asks; it is a
  backup, not an error.
- When `workspace scope resolved to the skill directory` appears, say the
  target must be the repo being checkpointed: rerun from there or pass
  `--project <dir>`.

### After status

- Always report installed/not installed and paused/active per scope, naming the
  config file of each installed scope. For a scope that is not installed, offer
  `安装 hook` (user) or `项目级别启用 hook` (workspace).
- `last run: ok` — call the hook healthy (run `--doctor` before guessing if
  commits are missing).
- `last run: FAILED <time> (<stage>)` — quote the line with its log path, name
  the failing stage, and point at
  [troubleshooting](references/troubleshooting.md); do not suggest a reinstall.
- `disabled: yes` — say the hook is paused, not uninstalled; `恢复 hook`
  resumes it without a reinstall.
- `ai: unavailable` / `skipped` / `disabled` / `FAILED` (`error` in `--json`)
  — say the commit still succeeded with a file-list placeholder message; it is
  diagnostics, not a failed commit, and `FAILED` lists per-model failures.
- `enabled: (n/a for command hooks)` — normal for command-string hosts; do not
  report it as a problem.
- With `--update`, quote `differing:` file names; `up to date` on both lines
  means nothing to do.

### After disable or enable

- `disable` keeps the registration: say commits stop from the next Stop, and
  `恢复 hook` resumes without a reinstall.
- `enable` resumes: say the next Stop commits again and no reinstall is
  needed.
- Neither rewrites the host config; never describe them as install/uninstall.

### After uninstall

- Say which scopes were removed (or `not installed in <file>`) and that other
  hooks were untouched.
- Without `--purge`, say the copied scripts remain so `安装 hook` works
  without reinstalling the skill; with `purged :`, say the scripts were
  removed (`backups/` is kept).

### After update

- Confirm `up to date` on both lines after refreshing (naming any `differing:`
  files that prompted it).
- Say hook assets take effect on the next Stop, while `SKILL.md`, `references/`
  and `scripts/` changes need a new session.

## Safety

- Runs `git add -A` every turn: all tracked/untracked, non-ignored changes are
  committed, including pre-existing user changes. Review `.gitignore` before
  enabling.
- Sensitive files pass a two-layer gate (filename rules plus model screening);
  excluded files stay uncommitted in the worktree and are omitted from the
  commit message. Set `noAiScreen` to skip the model layer only — the
  deterministic scan still runs. This is not a security boundary.
- Uses `--no-verify`, disables GPG signing, and skips
  merge/rebase/conflict/detached-HEAD states.
- Read [safety](references/safety.md) for host-specific caveats (merged Claude
  settings, `disableAllHooks` / `allowManagedHooksOnly`, workspace trust, and
  unignored `.zcode/` config).

## Reference files

- [environment](references/environment.md) — config keys, environment
  overrides, priority
- [troubleshooting](references/troubleshooting.md) — failure reporting, manual
  hook runs, common problems
- [safety](references/safety.md) — complete safety behaviour
