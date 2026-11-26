---
name: auto-commit-hook
description: >-
  Manage the automatic git checkpoint Stop hook (auto-commit) for agent
  workspaces: install, uninstall, update, inspect status/doctor, pause/resume,
  and configure runtime or model settings in config.json.
---

# Auto-commit hook

Commits workspace changes once per agent turn via a `Stop` hook (Conventional
Commits subject + AI body, or a deterministic `chore: update ...` file list
when no model is available). Excludes obvious sensitive files and always exits
0 so it never blocks a turn.

`<skill-dir>` is the directory containing this `SKILL.md` (default
`~/.agents/skills/auto-commit-hook` or `$AUTOCOMMIT_INSTALL_DIR`). Requires
`git` and `bash` (Git Bash on Windows); `run.sh` discovers Node/Electron
automatically.

## Rules

- **Check live state first**: run `bash <skill-dir>/scripts/run.sh status --all`
  before answering. Run `status --doctor` before explaining missing commits, and
  `status --update` before reporting drift.
- **Do not read or analyze `hooks/` or `scripts/`** during normal usage; rely on
  this guide, `references/`, and command output.
- **Run commands yourself** (except secret-bearing configs — see
  [Hook config](#hook-config)); never ask the user to run non-secret commands.
- Ground every answer in the printed output. On non-zero exit, quote the
  `Error:` line and its named fix first.
- Fix a paused hook with `enable` and a stale copy with an update — never a
  reinstall.

## Commands

Run `bash <skill-dir>/scripts/run.sh <command> [options]`:

- **Install / refresh hook**: `install`
  - `--scope user|workspace` (default `user`, all repos; `workspace` uses
    session project/cwd or `--project <dir>`). Installing both scopes commits
    twice per turn and is refused unless `--force`.
  - `--agent <agent>` overrides host detection; `--config <file>`,
    `--timeout <ms>` (default 30000), `--dry-run`.
- **Inspect & diagnose**:
  - `status` (current scope) | `status --all` | `status --all --json`
  - `status --doctor` (runtime blockers)
  - `status --update [--source <checkout>]` (drift vs source)
- **Pause / resume** (keeps host config; takes effect on next Stop):
  `disable` | `enable`
- **Uninstall** (removes only auto-commit entries; `--purge` also deletes
  copied scripts while keeping `backups/`):
  `uninstall [--agent <agent> --scope workspace --purge]`
- **Update the installed skill**:
  1. Refresh `<skill-dir>`: run `bash install.sh` from the checkout, or
     `curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash`.
  2. Refresh hook assets: `bash <skill-dir>/scripts/run.sh install`.
  3. Confirm `up to date` on both lines with `status --update`.
  Hook assets apply on the next Stop; `SKILL.md`, `references/`, and
  `scripts/` changes apply in a new session.

## Hook config

By default, commit messages use the host's session provider (or the local
`claude` CLI login on Claude Code when no endpoint is configured).
`<skill-dir>/config.json` stores optional overrides — see
[environment](references/environment.md) for keys and priority.

**Never ask or allow the user to hand-edit `config.json`**; `run.sh config` is
its sole writer.

```bash
bash <skill-dir>/scripts/run.sh config --show
bash <skill-dir>/scripts/run.sh config --set <key>=<value>
bash <skill-dir>/scripts/run.sh config --unset <key>
bash <skill-dir>/scripts/run.sh config --clear
```

- Run `--show`, `--set` (`noAi`, `noAiScreen`, `claudeBin`, `aiTimeoutMs`,
  `aiTotalMs`, `sourceDir`), `--unset`, and `--clear` yourself.
- **Secret hygiene**: never ask for, accept, print, reconstruct, or pass an API
  key in chat or in commands you run. If the user needs a manual endpoint
  (`url`/`key`/`model`), tell them to set `AUTOCOMMIT_LLM_*` env vars or run
  `bash <skill-dir>/scripts/run.sh config --url <url> --key <key> --model <models>`
  outside chat. Note that a saved manual endpoint outranks the session
  provider, while env vars still win per key.

## Reporting & safety

- Report in the user's language using the exact scope, config path, state
  (installed/paused/active), and when changes take effect (new session for
  `install`; next Stop for `enable`/`disable`/asset updates). Offer the next
  action in the user's language when a scope is uninstalled or paused.
- **Safety (summarize when installing or enabling)**: **every turn runs
  `git add -A` and commits all non-ignored changes (including pre-existing user
  changes) with `--no-verify` and GPG signing disabled; the sensitive-file gate
  is not a security boundary, and `.gitignore` should be reviewed first.**
  Merge/rebase/conflict/detached-HEAD states are skipped.
- If `status` reports `last run: FAILED ... (<stage>)`, quote the line with its
  log path and consult [troubleshooting](references/troubleshooting.md) instead
  of reinstalling. If `workspace` resolved to `<skill-dir>`, rerun from the
  target repo or pass `--project <dir>`.

## References

- [environment](references/environment.md) — config keys, env overrides,
  priority
- [troubleshooting](references/troubleshooting.md) — failure reporting,
  `claude -p` details, manual hook runs
- [safety](references/safety.md) — full safety gate and host-specific caveats
