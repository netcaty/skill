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
  subject/body; uses the provider config when available and local heuristics otherwise

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
`~/.zcode/hooks/auto-commit/` (copied by `install.cjs`). `status.cjs` hashes
the installed files and reports drift in its `update` section (`--json` adds
an `update` object to every result):

```bash
bash scripts/run.sh status
bash scripts/run.sh status --source /path/to/skill-checkout   # when no .source.json
```

The source checkout is remembered in
`~/.agents/skills/auto-commit-hook/.source.json` (written by `install.sh` —
local mode records the checkout path, download mode the repo URL), so
`status.cjs` usually finds it without `--source`. When no local checkout is
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
3. Re-run `bash scripts/run.sh status` and expect `up to date` on both lines.

Hook assets take effect on the next Stop event (the hook re-reads its scripts
every turn); updated `SKILL.md` and `scripts/` apply to new sessions.

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
- `更新 hook` (or `更新 skill`): run `bash scripts/run.sh status` first — its
  `update` section names the stale files. Then refresh the skill directory
  (checkout: `bash install.sh` there; no checkout: re-run the curl one-liner),
  run `bash scripts/run.sh install`, and re-run `status` to verify. Say that
  hook assets apply immediately while SKILL.md changes need a new session.
- `查看 hook 状态`: run `bash scripts/run.sh status --all` (add `--json` when the
  result is parsed programmatically). Report installed/enabled per scope and
  the `update` section — outdated files mean an update is available (see
  `更新 hook` above). A `last run: ok` line is healthy; `last run: FAILED
  <time> (<stage>)` names the failing step and the log path under the install
  directory, so quote it back to the user and suggest the fix.
- `设置 LLM 配置[: url=... key=... model=...]`: run
  `bash scripts/run.sh setup-llm --url <url> --key <key> [--model <id[,id...]>]`;
  ask for any missing values first. After saving, confirm with `--show`
  (key masked) and never echo the key in plain text. `查看 LLM 配置` runs
  `--show`, `清除 LLM 配置` runs `--clear`. The saved config outranks the
  session provider — say so when saving.

## What install does

1. Copies `hooks/auto-commit.sh` and `hooks/auto-commit-msg.cjs` to the agent's
   asset directory: `~/.zcode/hooks/auto-commit/` (zcode),
   `~/.workbuddy/hooks/auto-commit/` (workbuddy) or
   `~/.claude/hooks/auto-commit/` (claude).
2. Merges a `Stop` entry into the selected config:

   | agent | workspace | user |
   |---|---|---|
   | zcode | `<repo>/.zcode/config.json` | `~/.zcode/cli/config.json` |
   | workbuddy | `<repo>/.workbuddy/settings.json` | `~/.workbuddy/settings.json` |
   | claude | `<repo>/.claude/settings.local.json` | `~/.claude/settings.json` |

   WorkBuddy's user-scope file name follows the verified project-level layout;
   confirm it once with `status.cjs` on a real machine. Claude Code merges user
   settings, project `settings.json` (team-shared) and project
   `settings.local.json`; the installer writes the personal local file because
   the command embeds this machine's bash path. Pass
   `--config .claude/settings.json` only if the hook is meant to be committed
   for the whole team: every teammate (and every other OS) then needs their own
   registration, because that absolute bash path does not exist elsewhere.
3. Registers the hook in the agent's own format. ZCode gets `hooks.enabled: true`
   (required for configuration-file hooks; this also enables any other
   configuration hooks in that file — the installer warns):

```json
{
  "hooks": [{
    "type": "process",
    "command": "<bash executable>",
    "args": ["<posix path>/auto-commit.sh"],
    "timeoutMs": 30000,
    "statusMessage": "Running Auto-commit Hook"
  }]
}
```

   WorkBuddy gets a `command` hook with a quoted forward-slash command string and
   a whole-second timeout, matching the verified `hooks.Stop[]` layout (no
   `events` wrapper, no `enabled` flag):

```json
{
  "hooks": [{
    "type": "command",
    "command": "\"<bash>\" \"<script>/auto-commit.sh\"",
    "timeout": 30
  }]
}
```

   Claude Code uses the same command-string family; `matcher` is optional and
   omitted for Stop (the verified settings file has none), `timeout` is whole
   seconds, `statusMessage` is supported, and there is no `enabled` flag:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "\"<bash>\" \"<script>/auto-commit.sh\"",
        "timeout": 30,
        "statusMessage": "Running Auto-commit Hook"
      }]
    }]
  }
}
```

   Claude Code Stop payloads carry the final reply in `last_assistant_message`
   (verified against Claude Code 2.1.x hook-env dumps). The helper reads that
   field first and falls back to the JSONL transcript behind `transcript_path`
   — taking the last main-chain assistant text entry — for hosts or versions
   that omit it. Commit-message model sources: ZCode reads
   `provider_config.json`, WorkBuddy uses its session loopback proxy, and
   Claude Code uses the session's `ANTHROPIC_BASE_URL` +
   `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`, with the model taken from
   `ANTHROPIC_MODEL`, then `ANTHROPIC_SMALL_FAST_MODEL` /
   `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, then the ids listed in
   `CLAUDE_CODE_MODEL_CAPABILITIES`; the saved `llm-config.json` and
   `AUTOCOMMIT_LLM_*` overrides outrank all of them.

4. Backs up an existing config under `<agent asset dir>/backups/` (never next
   to the config — a workspace `.bak` would not be gitignored and `git add -A`
   could commit it) and records the previous `hooks.enabled` value in the
   agent's `install-state.json`.
5. Refuses to install when another merged config already registers the hook
   (the opposite scope, or either Claude project settings file) unless
   `--force`; two installs would commit twice per turn. For workbuddy bash
   resolution prefers the bundled `CODEBUDDY_CODE_GIT_BASH_PATH`; for claude it
   prefers `CLAUDE_CODE_GIT_BASH_PATH` (or `SHELL` when it points at bash).
   Both then fall back to the usual Git installs. To pin a specific bash for
   Claude Code, set `CLAUDE_CODE_GIT_BASH_PATH` in the settings `env`.

## Verify

```bash
bash scripts/run.sh status --scope workspace
```

Expect `installed` and `scripts: present`, and after a turn `last run: ok ...`.
`enabled: true` appears for ZCode only (command-string agents report
`enabled: (n/a for command hooks)`), and `git: ok` only when the command runs
inside a git repository (see the workspace-scope note above). A
`last run: FAILED ...` line names the failing stage and the log path (see
"Failure visibility").

- New sessions pick up the hook. Start a new session or reopen the workspace after
  installing.
- To run the installed hook manually (no model call):

```bash
printf '%s' '{"last_assistant_message":"test"}' \
  | ZCODE_PROJECT_DIR=/path/to/repo AUTOCOMMIT_NO_AI=1 \
    "<bash>" "$HOME/.zcode/hooks/auto-commit/auto-commit.sh"
git -C /path/to/repo log -1
```

  Claude Code variant — the real Stop payload carries both
  `last_assistant_message` and `transcript_path`; the helper prefers the field
  and falls back to the transcript's last assistant text entry:

```bash
printf '%s' '{"transcript_path":"/path/to/transcript.jsonl","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"test"}' \
  | CLAUDE_PROJECT_DIR=/path/to/repo AUTOCOMMIT_NO_AI=1 \
    "<bash>" "$HOME/.claude/hooks/auto-commit/auto-commit.sh"
git -C /path/to/repo log -1
```

## Failure visibility

The hook always exits 0 and never blocks a turn, so failures are reported out
of band instead of aborting:

- Every real failure (missing git, `git add`/`git commit` errors, a sensitive
  file that could not be unstaged) overwrites `last-run.json` and appends to
  `auto-commit.log` in the agent's asset directory. The log is created lazily
  on the first failure; a successful commit only overwrites `last-run.json`
  with `status: "ok"`, so a healthy install usually has no log file.
- `status.cjs` prints that state: `last run: FAILED <time> (<stage>) <detail>`
  plus the log path; `--json` exposes the same object as `lastRun`.
- Claude Code additionally receives a non-blocking stdout payload
  `{"systemMessage":"⚠ auto-commit failed (...)","suppressOutput":true}`, which
  the UI shows immediately. Other hosts get no stdout by default (their hook
  output schema is not verified); set `AUTOCOMMIT_NOTIFY_STDOUT=1` to force the
  same JSON channel for testing.
- Expected skips — not a repository, clean tree, merge/rebase in progress,
  detached HEAD — are not failures and are never reported. A missing model
  also falls back to the generic `chore: update N files` by design and is not
  reported as a failure.
- If a sensitive file cannot be unstaged, the hook aborts the commit, unstages
  everything, and reports stage `sensitive gate` instead of risking a leak.

## Uninstall

`uninstall.cjs` removes only entries whose script is `auto-commit.sh`, preserves all
other hooks, restores the `hooks.enabled` value recorded at install, and deletes the
config file only if the installer created it and nothing else remains. `--purge`
removes the copied scripts and install state when no remaining config references
them (the `backups/` directory is kept).

## Safety

- The hook runs `git add -A` every turn: all tracked/untracked, non-ignored changes
  are committed, including pre-existing user changes.
- Sensitive files get a two-layer gate before the commit. Layer 1 (deterministic)
  unstages obvious secret names — `.env*` (except `.env.example`-style), key/cert
  extensions (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.kdbx`),
  `id_rsa`-style SSH keys, `credentials*`/`secrets*` data files, service-account
  JSON, and `.npmrc`/`.pypirc`/`.netrc`. Layer 2 (best-effort) screens a clipped
  staged diff with the same model call that writes the commit message and can
  flag more paths. Every excluded path is listed in the commit body under
  `⚠ excluded from this commit (sensitive)`. This is not a security boundary:
  an unavailable model leaves only layer 1 (`AUTOCOMMIT_NO_AI=1` also disables
  layer 2), and flagged paths are always matched against the real staged list,
  so a hallucinated path can never unstage anything.
- It uses `--no-verify` and disables GPG signing for that commit.
- It commits on the current branch and skips merge/rebase/conflict/detached-HEAD
  states.
- Concurrent Stop events in the same repository serialize on
  `<git-dir>/auto-commit.lock`; a stale lock left by a killed hook is reclaimed
  on the next turn.
- A host re-enters `Stop` after another Stop hook blocks the turn and marks
  that payload `stop_hook_active: true`; such events are skipped so checkpoints
  cover completed turns only. The check is field-driven and applies to every
  agent that reports the field (Claude Code, WorkBuddy, ...); hosts that omit
  it are unaffected.
- Workspace config lives under `.zcode/`. If that directory is not ignored, the
  auto-commit hook will commit the config file itself.
- Claude Code merges hooks from user settings, project `settings.json` and
  project `settings.local.json`; every registered copy runs. Register the hook
  in one file only — `install.cjs` refuses another merged file that already has
  it, so do not also add it by hand to `settings.json`.
- Claude Code's `disableAllHooks` / `allowManagedHooksOnly` (in any merged
  settings file) stop the hook from running; `install.cjs` and `status.cjs`
  warn when they see them. Project-level hooks also require workspace trust.
- On Claude Code, `Stop` also fires on user interrupt, `/clear` and after
  compaction, so those end-of-turn events can produce a checkpoint commit too.
- The default scope is `user`, which applies to every project; use
  `--scope workspace` to limit the hook to a single repo.
- Review `.gitignore` before enabling. The hook never commits ignored files.

## Troubleshooting

- **Nothing commits**: run `status.cjs`; a `last run: FAILED ...` line names the
  failing stage and the log path. Confirm the hook is installed, the configured
  bash exists, and `git rev-parse` works under the current user. On ZCode also
  confirm `hooks.enabled: true`; on Claude Code check workspace trust and the
  `disableAllHooks` / `allowManagedHooksOnly` warnings. If git reports
  `dubious ownership`, run:
  `git config --global --add safe.directory <repo>`
- **Generic message** (`chore: update N files`): the helper did not run, or no model
  provider is configured. Check the Node/Electron runtime and the provider config
  (`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, default `~/.zcode/v2/provider_config.json`):
  the first rule with a `baseUrl` and an `access.apiKey` wins (`providerId` is
  user-set and never used for selection); its `api.type` decides request style and
  auth (`anthropic-messages` and `openai-chat-completions` both supported), and
  models are tried in the rule's `modelOrder` order.
- **Double commits**: installed in both scopes; uninstall one. On Claude Code
  also check both project files (`settings.json` and `settings.local.json`) —
  every merged copy runs; remove an old one with
  `--config .claude/settings.json`.
- **Config parse error**: the installer refuses to edit invalid JSON. Fix the file or
  pass `--config <file>`.
- **WorkBuddy / other agents**: pass `--agent workbuddy` (config format verified
  against a real `.workbuddy/settings.json`). Other agents: the hook scripts are
  agent-agnostic — pass `--config <path>` if the target uses ZCode's
  `hooks.events` schema, or extend `lib.cjs` with another branch (see
  "Adding a new agent" below for the checklist).
- **Claude Code**: pass `--agent claude` (workspace scope writes
  `.claude/settings.local.json`; user scope writes `~/.claude/settings.json`).
  The commit-message model comes from the session's `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` and, in order, `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`,
  then the ids in `CLAUDE_CODE_MODEL_CAPABILITIES`; a saved `llm-config.json`
  or `AUTOCOMMIT_LLM_*` outranks them. Without any model source commits still
  happen but with generic heuristic messages. If nothing commits, check that
  the project is trusted, no merged settings file sets `disableAllHooks` /
  `allowManagedHooksOnly` (`status.cjs` warns), and the registered bash path
  still exists.
- **Mixed agents**: the hook scripts detect their host at runtime (env-var
  prefixes), so the same install works under any supported host; `--agent` only
  selects where the hook is registered and in which format.

## Adding a new agent (e.g. dsh)

Support is plugin-shaped: `scripts/lib.cjs` holds the authoritative
`AGENT_PROFILES` registry (one `defineAgent()` entry per agent), and
`detectAgent()` / `installDir()` / `configPath()` / `ensureStopHook()` are
thin dispatchers over it — after detection, everything goes through the
profile. Confirm the facts below against the target agent (a real hook-env
dump plus its installed config file are the ground truth — never guess),
then add one profile. The `claude` profile is the worked example to copy.

| profile field | meaning |
|---|---|
| `name` | the `--agent` value |
| `priority` | detection order; brand-specific markers must win over shared ones (workbuddy 10 < zcode 20 < claude 30) |
| `detect(env)` | predicate over the session's env markers |
| `installDir(home)` | the agent's asset-copy directory |
| `configPaths(project, home)` | `{ workspace, user }` hook config paths |
| `hookSchema` | key into `HOOK_SCHEMA_WRITERS` (same file) |

Steps:

1. Add the `defineAgent()` entry to `AGENT_PROFILES` in `scripts/lib.cjs`;
   `AGENTS` (the `--agent` validation list) derives from it automatically.
2. Only for a genuinely new hook JSON layout: add a writer to
   `HOOK_SCHEMA_WRITERS`. Covered families: `process-events` (zcode — nested
   `hooks.events.<Event>[]`, process argv, `hooks.enabled`) and `command-flat`
   (workbuddy — flat `hooks.<Event>[]`, quoted command string, whole-second
   timeout); `command-flat-claude` is the claude variant (same layout, plus
   `statusMessage`, without the optional `matcher`).
   `eventArrays`/`isOurHook`/`stripOurHooks` iterate both known layouts, so
   same-family agents need nothing there.
3. Only for a genuinely new commit-message model source: add the loader to
   `MODEL_SOURCES` in `hooks/auto-commit-msg.cjs` (the runtime mirror of
   `AGENT_PROFILES`), plus an alias if the agent shares an existing source.
   No source means the local-heuristic fallback still commits.
4. Optionally add a marker row to the detection table in
   `hooks/auto-commit.sh` (the bash mirror of the registry). Without it the
   agent still works as `unknown` — the cd chain, runtime fallback and
   model-source probe all handle that; the row only improves runtime
   candidate ordering.
5. Stop payload: `parsePayload()` is deliberately field-driven, not
   agent-driven (`last_assistant_message` first, then `transcript_path` — a
   wrong detection cannot lose the message). If the new agent exposes the
   final reply some other way, extend the field fallback there.
6. Update the config table and hook JSON example in this file, the
   `--agent` help lines in the three scripts, and the runtime candidate
   lists in `hooks/auto-commit.sh` and `scripts/run.sh` — keep those two in
   sync — if the agent bundles a Node/Electron runtime worth probing
   (Claude Code has none — PATH node suffices).

## Files

Everything under `hooks/` and `scripts/` is installed verbatim; see the
commands above for what each script does.

The hook always executes the asset copies in `~/.zcode/hooks/auto-commit/`
(or `~/.workbuddy/...`, `~/.claude/...`) — never this directory — which is why
refreshing takes both steps in "Update the installed skill" above, and why
`install.sh` alone does not refresh the hook.
