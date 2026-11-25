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
  show, or clear the LLM config.
---

# Auto-commit hook

Commits workspace changes once per agent turn through a `Stop` hook. Each commit
gets a Conventional Commits subject and an AI-written body, falling back to
local heuristics when no model is available; obvious sensitive files are
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

## Requirements

| need | detail |
|---|---|
| `bash` | Git Bash on Windows |
| `git` | the repository being checkpointed |
| Node | not required on `PATH`; `run.sh` discovers a runtime (see [Runtime](#runtime)) |

### Environment overrides

All optional — see [environment](references/environment.md).

## Conventions

This document is host-neutral. Placeholders stand for values the scripts resolve
at runtime; replace them with the resolved values before running a command.

| placeholder | meaning |
|---|---|
| `<skill-dir>` | installed skill directory: `$AUTOCOMMIT_INSTALL_DIR`, default `~/.agents/skills/auto-commit-hook` |
| `<agent>` | detected host profile id, as printed by `status` and accepted by `--agent` |

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

`scripts/run.sh` locates its own scripts, so this works from anywhere. From a
curl-only install, use `bash <skill-dir>/scripts/run.sh install`.

- `--scope user` (default) applies to every project; `--scope workspace` limits
  the hook to one repo.
- The host is auto-detected from the session environment; `--agent <agent>`
  overrides it, e.g. to install for another host from inside a session.
- `--config <file>` and `--timeout <ms>` override the config path and the hook
  timeout (default 30000 ms); `--dry-run` prints the planned change without
  writing.
- Installing both scopes commits twice per turn; `install.cjs` refuses unless
  `--force`.

### Scope and project resolution

Workspace scope resolves the project from the session environment
(`CODEBUDDY_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, `ZCODE_PROJECT_DIR`, in that
order) and falls back to the current directory, so run it from the target repo
or pass `--project <dir>`. If the resolved project is the skill directory
itself, the scripts warn that the target must be the repo being checkpointed.

### Runtime

`run.sh` finds Node even when it is not on `PATH`; `AUTOCOMMIT_NODE` pins a
runtime and `bash scripts/run.sh --print` shows the one chosen.
`node scripts/<command>.cjs ...` is equivalent where Node is on `PATH`.

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
  failures). `transport` is `http` or `cli`; `cli` means the local `claude -p`
  login state was used. Diagnostics only; the commit still succeeded.
- `--doctor` also checks the configured bash, host disable flags, git usability
  and, with `--all`, duplicate scope installs.

For a failed run, see [troubleshooting](references/troubleshooting.md), which
also shows how to run the installed hook by hand.

## Pause and resume

```bash
bash scripts/run.sh disable
bash scripts/run.sh enable
```

`disable` keeps the registration and pauses commits from the next Stop;
`enable` resumes them. `install` preserves a pause; `uninstall` clears it.

## Update the installed skill

Two copies refresh independently: the skill directory and the hook assets.
`status --update` reports drift between them and the source checkout.

```bash
bash scripts/run.sh status --update
bash scripts/run.sh status --update --source /path/to/skill-checkout   # if none was recorded
```

`--source` is usually unnecessary: `install.sh` records the checkout. Without a
recorded checkout, the skill-dir comparison is skipped and the download update
below applies.

Refresh — every step is idempotent; the hook registration is untouched:

1. Refresh the skill directory: run `bash install.sh` from the checkout, or
   re-run the curl one-liner without one.
2. Refresh the hook assets: `bash scripts/run.sh install`.
3. Re-run `bash scripts/run.sh status --update` and expect `up to date` on both
   lines.

Hook assets take effect on the next Stop; updated `SKILL.md`, `references/` and
`scripts/` apply to new sessions. A paused hook stays paused across `install`;
`enable` resumes it.

## Uninstall

```bash
bash scripts/run.sh uninstall
bash scripts/run.sh uninstall --agent <agent> --scope workspace --purge
```

To stop commits temporarily, use `disable` instead — it leaves the registration
alone. Uninstall is for removing the registration itself.

`uninstall` removes only the auto-commit entries and preserves all other hooks;
it cleans up the config file it created. `--purge` also removes the copied
scripts and install state when unreferenced (`backups/` is kept).

## Commit-message model

By default the message uses the host's session provider. A saved config at
`<skill-dir>/llm-config.json` (default
`~/.agents/skills/auto-commit-hook/llm-config.json`; override the path with
`AUTOCOMMIT_LLM_CONFIG`) outranks it, and `AUTOCOMMIT_LLM_*` env overrides
outrank the saved config. With no model source at all, commits still happen
with heuristic messages.

On Claude Code, when the session has no provider env and no saved config, the
message uses the installed `claude` CLI's own login (including subscription
OAuth); it never reads credentials files or the Keychain. The model is fixed to
`haiku`, and `AUTOCOMMIT_LLM_MODEL` does not affect this path.

The file is user-managed: never ask for an API key in the conversation and never
run a command that takes it as an argument. Give the user the path and this
format, and let them add the key themselves:

```json
{
  "url": "https://example.com/v1/messages",
  "key": "sk-...",
  "model": ["glm-5.3-flash", "auto/glm-5.3-flash"]
}
```

`url`, `key` and `model` are required. A URL ending in `/v1/messages` uses the
Anthropic request style, `/v1/chat/completions` the OpenAI one; `model` takes a
list tried in order (a comma-separated string works too).

```bash
bash scripts/run.sh setup-llm --show     # verify; the key is masked
bash scripts/run.sh setup-llm --clear    # remove the file
```

`setup-llm --url/--key/--model` is for scripted setups only; do not use it to
collect a key from the user.

## What to tell the user

Report in the user's terms — scope, whether the registration was kept, and when
a change takes effect. **Run every command yourself; never ask the user to
execute one manually.** Ground every report in the lines the command just
printed; never claim a state `status` has not shown. If a command exits
non-zero, quote its `Error:` line and the fix it names before suggesting
anything else. Below, `install`, `status`, `disable` and so on are
`bash scripts/run.sh` subcommands.

### After install

- Always name the scope: `user` covers every project, `workspace` only the
  resolved repo, and the config file it wrote. Say a new session (or reopening
  the workspace) picks up the registration.
- With the hook enabled, point the user at [Safety](#safety): every turn it
  commits all tracked and untracked changes that are not ignored, including
  changes made before it was installed, and the sensitive-file filter is not a
  security boundary. Tell them to review `.gitignore` before relying on it —
  ignored files are never committed.
- When the output shows `paused : yes` or `Note: auto-commit is paused`, say
  the hook stays paused and `恢复 hook` resumes it without a reinstall.
- When the output shows `backup :`, quote the path only if the user asks about
  their previous config; it is a backup, not an error.
- When the output warns `workspace scope resolved to the skill directory`, say
  the target must be the repo being checkpointed: rerun from there or pass
  `--project <dir>`.

### After status

- Always report installed/not installed and paused/active per scope, naming the
  config file of each installed scope. For a scope that is not installed, offer
  `安装 hook` (user) or `项目级别启用 hook` (workspace).
- `last run: ok` — call the hook healthy. If the user asked why no commit
  happened, run `--doctor` before guessing.
- `last run: FAILED <time> (<stage>)` — quote the line with its log path, name
  the failing stage, and point at
  [troubleshooting](references/troubleshooting.md); do not suggest a reinstall.
- `disabled: yes` — say the hook is paused, not uninstalled; `恢复 hook`
  resumes it without a reinstall.
- `ai: unavailable` / `skipped` / `disabled` / `error` — say the commit still
  succeeded with a heuristic message; it is diagnostics, not a failed commit,
  and `error` lists per-model failures.
- `enabled: (n/a for command hooks)` — normal for command-string hosts; do not
  report it as a problem.
- With `--update`, quote the `differing:` file names; `up to date` on both
  lines means there is nothing to do.

### After disable or enable

- `disable` keeps the registration and writes a pause marker: say commits stop
  from the next Stop, and `恢复 hook` resumes without a reinstall.
- `enable` removes the marker: say the next Stop commits again and no reinstall
  is needed.
- Neither rewrites the host config; never describe them as install/uninstall.

### After uninstall

- Say which scopes the entry was removed from and that other hooks were left
  untouched.
- When the output says `not installed in <file>`, say nothing was registered
  there and no change was made.
- When a `pause :` line appears, say the pause marker was cleared.
- Without `--purge`, say the copied scripts remain, so `安装 hook` works without
  reinstalling the skill; with `purged :`, say the scripts were removed
  (`backups/` is kept).

### After update

- Report which `differing:` files prompted the refresh, and confirm
  `up to date` on both lines afterwards.
- Say hook assets take effect on the next Stop, while `SKILL.md`, `references/`
  and `scripts/` changes need a new session.

### For the LLM config

- Never print, request, or accept an API key in chat; the user writes it into
  `<skill-dir>/llm-config.json` themselves, and `setup-llm --show` reports it
  masked.
- When `--show` prints `file :` and `url :`, read them back as the effective
  endpoint; never reconstruct or guess the masked key.
- When it prints `No manual LLM config saved`, say the host's session provider
  is used; offer the file path and format if the user wants a manual endpoint.
- When `--clear` prints `Cleared <file>`, say the host session provider is used
  again; `No manual LLM config to clear` means there was nothing to remove.
- Whenever a saved config is involved, mention that it outranks the session
  provider.
- When `ai` shows `transport: cli`, say the message came from the local Claude
  Code login state. If the attempt says `Not logged in`, the commit still
  succeeded with a heuristic message; after the user logs in again, the next
  turn retries automatically.

## Safety

- The hook runs `git add -A` every turn: all tracked/untracked, non-ignored
  changes are committed, including pre-existing user changes.
- Sensitive files get a two-layer gate before the commit (obvious secret names
  are unstaged by name; a model screens a clipped diff and can flag more).
  Excluded files stay uncommitted in the worktree and are not named in the
  commit message. This is not a security boundary.
- It uses `--no-verify`, disables GPG signing, and skips
  merge/rebase/conflict/detached-HEAD states.
- Default user scope applies to every project; use `--scope workspace` to limit
  it. Review `.gitignore` before enabling — the hook never commits ignored
  files.
- Host-specific caveats — merged Claude settings, `disableAllHooks` /
  `allowManagedHooksOnly`, workspace trust, and `.zcode/` config being
  committed when not ignored — are in [safety](references/safety.md).

## Reference files

- [environment](references/environment.md) — environment variable overrides
- [troubleshooting](references/troubleshooting.md) — failure reporting, manual
  hook runs, common problems
- [safety](references/safety.md) — complete safety behaviour
