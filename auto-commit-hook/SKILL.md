---
name: auto-commit-hook
description: >-
  Install, uninstall, update, inspect, pause, resume, or troubleshoot the
  automatic git checkpoint Stop hook (auto-commit) for agent workspaces. Use
  when the user asks to enable or disable auto-commit, install, remove, update
  or upgrade the Stop hook or the installed skill, set up per-turn git
  checkpoints, configure the model that writes commit messages, or diagnose why
  automatic commits are not happening.
  触发词：启用/暂停/恢复/禁用 自动提交，安装/卸载/更新/升级 hook 或 skill，查看 hook 状态，设置/查看/清除 LLM 配置。
---

# Auto-commit hook

Commits workspace changes once per agent turn through a `Stop` hook. Each commit
gets a Conventional Commits subject and an AI-written body, falling back to
local heuristics when no model is available; obvious sensitive files are
excluded, and the hook always exits 0 — it never blocks or fails a turn.

The skill ships two hook scripts:

- `auto-commit.sh` — guards, stages, commits, records the outcome, always exits 0
- `auto-commit-msg.cjs` — turns the agent's final reply into a commit message and
  records the attempt under `ai` in `last-run.json`

## Before you act

Check live state instead of reciting from this file:

```bash
bash scripts/run.sh status --all
```

- Run `status --doctor` before explaining why commits are missing.
- Run `status --update` before saying whether installed files are current.
- Read the matching [reference file](#reference-files) before explaining
  internals or safety.

A paused hook or a stale copy is fixed by `enable` or an update, not by a
reinstall.

## Requirements

| need | detail |
|---|---|
| `bash` | Git Bash on Windows |
| `git` | the repository being checkpointed |
| Node | not required on `PATH`; `run.sh` discovers a runtime (see [Runtime](#runtime)) |
| model | optional; without one, commits still happen with heuristic messages |

### Environment overrides

All optional:

| variable | effect |
|---|---|
| `AUTOCOMMIT_INSTALL_DIR` | installed skill directory (default `~/.agents/skills/auto-commit-hook`) |
| `AUTOCOMMIT_NODE` | Node runtime for `run.sh` |
| `AUTOCOMMIT_BASH` | bash executable registered in the hook |
| `AUTOCOMMIT_NO_AI=1` | skip the model call; use a heuristic message |
| `AUTOCOMMIT_LLM_URL` / `_KEY` / `_MODEL` | override the saved LLM config |
| `AUTOCOMMIT_LLM_CONFIG` | alternate `llm-config.json` path |
| `AUTOCOMMIT_SOURCE_DIR` | source checkout for `status --update` |
| `AUTOCOMMIT_NO_SKILL_LINK=1` | skip the `<skills-dir>` link in `install.sh` |
| `CODEBUDDY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` / `ZCODE_PROJECT_DIR` | session project used by workspace scope, in that order |

`AUTOCOMMIT_NOTIFY_STDOUT=1` forces the failure-notification JSON channel for
testing; see [troubleshooting](references/troubleshooting.md).

## Conventions

This document is host-neutral. Placeholders stand for values the scripts resolve
at runtime; replace them with the resolved values before running a command. The
concrete per-host table lives in [install internals](references/install-internals.md).

| placeholder | meaning |
|---|---|
| `<skill-dir>` | installed skill directory: `$AUTOCOMMIT_INSTALL_DIR`, default `~/.agents/skills/auto-commit-hook` |
| `<agent>` | detected host profile id, as printed by `status` and accepted by `--agent` |
| `<AGENT>` | `<agent>` uppercased; prefixes the host's session environment variables |
| `<agent-home>` | that host's own config home (one directory per host) |
| `<hooks-dir>` | `<agent-home>/hooks/auto-commit`, where `install.cjs` copies the hook assets |
| `<skills-dir>` | `<agent-home>/skills/auto-commit-hook`, the discoverability link some hosts require |

## Install

### The skill (no local checkout)

For machines that only have the repository URL:

```bash
curl -fsSL https://raw.githubusercontent.com/netcaty/skill/main/install.sh | bash
```

The script stages this skill directory at `<skill-dir>` and registers no hook.
On hosts that scan only their own `skills/` directory, it also exposes the
staged copy at `<skills-dir>` — a directory junction on Windows, a symlink on
macOS/Linux, falling back to a copy. A host that reads `<skill-dir>` directly
needs no link. Set `AUTOCOMMIT_NO_SKILL_LINK=1` to skip it.

Use a raw.githubusercontent URL; piping the github.com page feeds HTML to bash.

### The hook

```bash
bash scripts/run.sh install
```

`scripts/run.sh` locates its own scripts, so this works from anywhere. From a
curl-only install, use `bash <skill-dir>/scripts/run.sh install`.

- `--scope user` (default) applies to every project; `--scope workspace` limits
  the hook to one repo.
- The host is auto-detected from the session environment; `--agent <agent>`
  overrides it, e.g. to install for another host from inside a session.
- `--dry-run` prints the planned change without writing.
- Installing both scopes commits twice per turn; `install.cjs` refuses unless
  `--force`.

### Scope and project resolution

Workspace scope resolves the project from the session environment
(`CODEBUDDY_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, `ZCODE_PROJECT_DIR`, in that
order) and falls back to the current directory, so run it from the target repo
or pass `--project <dir>`. If the resolved project is the skill directory
itself, the scripts print a warning: `status` reports `not a git repository`
there, an install would register a workspace hook for the skill checkout, and
any `safe.directory` hint it prints would not apply.

### Runtime

`run.sh` finds Node without requiring it on `PATH`, in order: `node` on `PATH`,
`$AUTOCOMMIT_NODE`, the host's bundled runtime
(`$<AGENT>_NODE_FALLBACK_EXEC_PATH`), the host app's install locations
(`%LOCALAPPDATA%\Programs` on Windows; `/Applications/*.app` and
`~/Applications` on macOS, with the executable read from Info.plist's
`CFBundleExecutable`), then scoop, `Program Files\nodejs`, Homebrew and
`/usr/local/bin`. Electron binaries run with `ELECTRON_RUN_AS_NODE=1`;
`.cmd`/`.bat` shims are skipped because bash cannot exec them directly.

`bash scripts/run.sh --print` shows the chosen runtime without running a
command. `node scripts/<command>.cjs ...` is equivalent wherever Node is on
`PATH`.

## Status and diagnostics

```bash
bash scripts/run.sh status                  # current scope
bash scripts/run.sh status --all            # user + workspace
bash scripts/run.sh status --all --json     # machine-readable
bash scripts/run.sh status --doctor         # runtime blockers
bash scripts/run.sh status --update         # drift vs the source
```

What the lines mean:

- `installed` / `scripts: present` — registration and copied assets.
- `last run: ok` — healthy. `last run: FAILED <time> (<stage>)` names the
  failing stage; the log path sits under the install directory. Quote both back
  and suggest the fix.
- `disabled: yes` — paused, not uninstalled. `run.sh enable` resumes it.
- `ai:` — how the message was produced: `ok`, `disabled`, `skipped`,
  `unavailable` (sources checked and why each was empty) or `error` (per-model
  failures). Diagnostics only; the commit still succeeded.
- `enabled: true` appears only for hosts whose hook format has an `enabled`
  flag; command-string hosts report `enabled: (n/a for command hooks)`.
- `--doctor` also checks the configured bash, host disable flags, git usability
  (a `safe.directory` fix is suggested only for the ownership case) and, with
  `--all`, duplicate scope installs.
- `--update` reports drift; see [Update the installed skill](#update-the-installed-skill).

For a failed run, see [troubleshooting](references/troubleshooting.md), which
also shows how to run the installed hook by hand.

## Pause and resume

```bash
bash scripts/run.sh disable
bash scripts/run.sh enable
```

`disable` writes a `disabled.json` marker in `<hooks-dir>`; no config is
rewritten, the registration is kept, and the hook stops on the next Stop.
`enable` removes the marker and the next Stop commits again. `install`
preserves a pause; `uninstall` clears it.

## Update the installed skill

Installed copies go stale in two places that refresh independently:
`<skill-dir>` (staged by `install.sh`; the `<skills-dir>` link follows it) and
`<hooks-dir>` (copied by `install.cjs`). `status --update` hashes both and
reports drift; `--json` adds an `update` object to every result.

```bash
bash scripts/run.sh status --update
bash scripts/run.sh status --update --source /path/to/skill-checkout   # when no .source.json
```

The source checkout is remembered in `<skill-dir>/.source.json` (written by
`install.sh` — local mode records the checkout path, download mode the repo
URL), so `--source` is usually unnecessary. When no local checkout is recorded,
the skill-dir comparison is skipped and the download update below applies.

Refresh — every step is idempotent; the hook registration is untouched:

1. Refresh the skill directory: run `bash install.sh` from the checkout, or
   re-run the curl one-liner without one. This also refreshes the
   `<skills-dir>` links.
2. Refresh the hook assets: `bash scripts/run.sh install`.
3. Re-run `bash scripts/run.sh status --update` and expect `up to date` on both
   lines.

Hook assets take effect on the next Stop (the hook re-reads them every turn);
updated `SKILL.md`, `references/` and `scripts/` apply to new sessions. A paused
hook stays paused across `install`; `enable` resumes it.

## Uninstall

```bash
bash scripts/run.sh uninstall
bash scripts/run.sh uninstall --agent <agent> --scope workspace --purge
```

To stop commits temporarily, use `disable` instead — it leaves the registration
alone. Uninstall is for removing the registration itself.

`uninstall.cjs` removes only entries whose script is `auto-commit.sh`, preserves
all other hooks, restores the `hooks.enabled` value recorded at install, and
deletes the config file only if the installer created it and nothing else
remains. `--purge` also removes the copied scripts and install state when no
remaining config references them (the `backups/` directory is kept).

## Commit-message model

By default the message uses the host's session provider. A saved config at
`~/.agents/skills/auto-commit-hook/llm-config.json` (override the path with
`AUTOCOMMIT_LLM_CONFIG`) outranks it; `AUTOCOMMIT_LLM_*` env overrides outrank
the saved config.

```bash
bash scripts/run.sh setup-llm --url https://example.com/v1/messages --key sk-... --model glm-5.3-flash,auto/glm-5.3-flash
bash scripts/run.sh setup-llm --show
bash scripts/run.sh setup-llm --clear
```

`--model` accepts a comma-separated candidate list tried in order. `--show`
masks the key; never echo the key in plain text. With no model source at all,
commits still happen with heuristic messages. Per-host sources are listed in
[install internals](references/install-internals.md).

## What to tell the user

Report outcomes in the user's terms — scope, whether the registration was kept,
and when the change takes effect — and offer the matching dialog phrases
instead of raw script commands. Below, `install`, `status`, `disable` and so on
are `bash scripts/run.sh` subcommands:

- `安装 hook` / `启用自动提交` — run `install` (user scope). If any scope is
  already installed, report that instead of adding a second one.
- `项目级别启用 hook` — if nothing is installed, run `install --scope
  workspace`. If user scope is installed, uninstall it first: two scopes commit
  twice per turn, and `install.cjs` refuses both. If workspace scope is already
  installed, say so.
- `禁用 hook` — run `status` first, then `disable`. This pauses the hook without
  uninstalling; leave the registration in place unless the user asks to remove
  it.
- `恢复 hook` / `恢复自动提交` — run `enable`; the next Stop commits again, and no
  reinstall is needed.
- `卸载 hook` — run `status` first, then `uninstall` for every installed scope
  (add `--scope workspace` where needed). This removes the entry and clears any
  pause marker; keep the copied scripts unless the user asks for `--purge`.
- `更新 hook` / `更新 skill` — run `status --update` first to name the stale
  files, then refresh the skill directory (checkout: `bash install.sh`;
  otherwise re-run the curl one-liner), run `install`, and verify with
  `status --update`. Tell the user hook assets apply on the next Stop, while
  `SKILL.md` changes need a new session.
- `查看 hook 状态` — run `status --all`, adding `--json` for machine parsing,
  `--update` for stale files, or `--doctor` for blockers. Report
  installed/enabled/paused per scope.
- `设置 LLM 配置[: url=... key=... model=...]` — ask for missing values, then run
  `setup-llm --url <url> --key <key> [--model <id[,id...]>]`; confirm with
  `--show` and never echo the key. Mention that the saved config outranks the
  session provider.
- `查看 LLM 配置` / `清除 LLM 配置` — run `setup-llm --show` / `setup-llm --clear`.

When reporting:

- **Installed** — user scope covers every project; a new session, or reopening
  the workspace, picks up the registration.
- **Status** — report installed/paused per scope. `last run: ok` is healthy;
  quote a `last run: FAILED <time> (<stage>)` line with its log path and fix.
  The `ai:` line explains a heuristic message; it is not a failed commit.
- **Paused** — the registration is kept; `恢复 hook` resumes it without a
  reinstall.
- **Keys** — never print an API key; use the masked `setup-llm --show`.

## Safety

- The hook runs `git add -A` every turn: all tracked/untracked, non-ignored
  changes are committed, including pre-existing user changes.
- Sensitive files get a two-layer gate before the commit (obvious secret names
  are unstaged by name; a model screens a clipped diff and can flag more), and
  every exclusion is listed in the commit body. This is not a security boundary.
- It uses `--no-verify`, disables GPG signing, skips merge/rebase/conflict/
  detached-HEAD states, serializes concurrent Stops on
  `<git-dir>/auto-commit.lock`, and skips `stop_hook_active: true` re-entries.
- Default user scope applies to every project; use `--scope workspace` to limit
  it. Review `.gitignore` before enabling — the hook never commits ignored
  files.
- Host-specific caveats — merged Claude settings, `disableAllHooks` /
  `allowManagedHooksOnly`, workspace trust, and `.zcode/` config being
  committed when not ignored — are in [safety](references/safety.md).

## Option reference

`scripts/run.sh <command> [options]` runs `scripts/<command>.cjs`; commands are
`install`, `uninstall`, `disable`, `enable`, `status` and `setup-llm`.

| option | commands | meaning |
|---|---|---|
| `--agent <agent>` | install, uninstall, status, disable, enable | override host detection |
| `--scope` | install, uninstall, status | `user` (default) or `workspace` |
| `--project <dir>` | install, uninstall, status, disable | workspace root; default session project or cwd |
| `--config <file>` | install, uninstall | explicit hooks config path |
| `--timeout <ms>` | install | hook timeout, default 30000 |
| `--force` | install | install despite another merged config already having the hook |
| `--dry-run` | install, uninstall, disable, enable | print the planned change without writing |
| `--purge` | uninstall | remove copied scripts (keeps `backups/`) when unreferenced |
| `--all` | status | show user and workspace scopes |
| `--doctor` | status | runtime blockers and git ownership |
| `--update` | status | drift between installed and source files |
| `--source <dir>` | status `--update` | checkout path when no `.source.json` |
| `--json` | all | machine-readable result |
| `--url`, `--key`, `--model` | setup-llm | endpoint and candidate models |
| `--show`, `--clear` | setup-llm | print (masked) or remove the saved config |

## Reference files

- [install internals](references/install-internals.md) — what install writes,
  config paths, hook JSON per agent, commit-message model sources
- [troubleshooting](references/troubleshooting.md) — failure reporting, manual
  hook runs, common problems
- [safety](references/safety.md) — complete safety behaviour
- [adding an agent](references/adding-an-agent.md) — support checklist for a new
  host
