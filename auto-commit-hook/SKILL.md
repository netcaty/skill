---
name: auto-commit-hook
description: >-
  Install, uninstall, inspect, or troubleshoot the automatic git checkpoint Stop hook
  (auto-commit) for ZCode/WorkBuddy/Claude Code workspaces. Use when the user asks to
  enable or disable auto-commit, install or remove the Stop hook, set up per-turn git
  checkpoints, or diagnose why automatic commits are not happening.
  触发词：启用/禁用 自动提交，安装/卸载 hook。
---

# Auto-commit hook

This skill installs a `Stop` hook that commits workspace changes once per agent turn.
The hook is a pair of scripts bundled under `hooks/`:

- `auto-commit.sh` — guards, stages changes, commits, and always exits 0
- `auto-commit-msg.cjs` — turns the agent's final reply into a Conventional Commits
  subject/body; uses the provider config when available and local heuristics otherwise

## One-line install

For machines that only have the repository URL (no local checkout):

```bash
curl -fsSL https://raw.githubusercontent.com/netcaty/zcode-sync/main/install.sh | bash
```

The script only stages this skill directory to `~/.agents/skills/auto-commit-hook/`
— it does not register any hook. To enable auto-commit afterwards:

```bash
node ~/.agents/skills/auto-commit-hook/scripts/install.cjs
```

(agent auto-detected from the session environment, user scope by default).
Use a raw.githubusercontent URL; piping the github.com page feeds HTML to bash.

## Quick commands

Run these from this skill directory. Every command accepts `--scope user`
(default) or `--scope workspace`. The agent (`zcode`, `workbuddy` or `claude`) is
auto-detected from the session environment the same way the hook scripts do it,
so `--agent` is only needed to override detection (e.g. installing for
WorkBuddy from a ZCode session).

```bash
# Install for every workspace (default scope)
node scripts/install.cjs

# Install for the current project only
node scripts/install.cjs --scope workspace

# Install for WorkBuddy (agent auto-detected, or force it with --agent)
node scripts/install.cjs --agent workbuddy

# Preview without writing
node scripts/install.cjs --dry-run

# Inspect
node scripts/status.cjs
node scripts/status.cjs --agent workbuddy --all --json

# Uninstall (keep the copied scripts)
node scripts/uninstall.cjs

# Uninstall and remove copied scripts when nothing else references them
node scripts/uninstall.cjs --agent workbuddy --scope workspace --purge

# Manual LLM endpoint for commit messages (stored in
# ~/.agents/skills/auto-commit-hook/llm-config.json; wins over the session
# provider, AUTOCOMMIT_LLM_* env overrides win over it)
node scripts/setup-llm.cjs --url https://example.com/v1/messages --key sk-... --model glm-5.3-flash,auto/glm-5.3-flash
node scripts/setup-llm.cjs --show
node scripts/setup-llm.cjs --clear
```

If `node` is not on `PATH`, run the same script with the agent's Electron runtime:

```bash
# ZCode (Windows)
ELECTRON_RUN_AS_NODE=1 "$ZCODE_WINDOWS_APP_INSTALL_DIR/ZCode.exe" scripts/install.cjs --scope workspace

# ZCode (macOS — the binary name follows Info.plist's CFBundleExecutable,
# which may differ from the bundle name; e.g. "Visual Studio Code.app"
# ships Contents/MacOS/Code)
ELECTRON_RUN_AS_NODE=1 /Applications/ZCode.app/Contents/MacOS/ZCode scripts/install.cjs --scope workspace

# WorkBuddy (--agent because a plain shell has no WorkBuddy env to auto-detect)
ELECTRON_RUN_AS_NODE=1 "$WB_SHT_INSTDIR/WorkBuddy.exe" scripts/install.cjs --agent workbuddy          # Windows
ELECTRON_RUN_AS_NODE=1 /Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy scripts/install.cjs --agent workbuddy   # macOS
```

The agents' bundled Node runtimes (`$ZCODE_NODE_FALLBACK_EXEC_PATH` /
`$WORKBUDDY_NODE_FALLBACK_EXEC_PATH`) are accepted too and tried first by the
hook scripts. Without the agent's env vars, the executables live in
`%LOCALAPPDATA%\Programs\{ZCode,WorkBuddy}\` (Windows) or inside the
`/Applications/{ZCode,WorkBuddy}.app` bundles (macOS, `~/Applications` probed
as well) — the hook resolves the real binary from `Info.plist`
(`CFBundleExecutable`) instead of assuming the bundle name.

## Dialog follow-ups

After installing, tell the user the dialog prompts — not raw node commands:
`项目级别启用 hook` applies the hook to the current project only; `禁用 hook`
removes it. When the user types them:

- `项目级别启用 hook`: nothing installed yet → run
  `node scripts/install.cjs --scope workspace`. If user scope is installed,
  uninstall it first and then install workspace scope — install.cjs refuses
  both scopes at once, and running them together commits twice per turn. If
  workspace scope is already installed, just say so.
- `禁用 hook`: run `node scripts/status.cjs` first, then uninstall every
  installed scope (`node scripts/uninstall.cjs`, plus `--scope workspace`
  where needed). Keep the copied scripts unless the user asks for `--purge`.
- `设置 LLM 配置[: url=... key=... model=...]`: run
  `node scripts/setup-llm.cjs --url <url> --key <key> [--model <id[,id...]>]`;
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
   | claude | `<repo>/.claude/settings.json` | `~/.claude/settings.json` |

   WorkBuddy's user-scope file name follows the verified project-level layout;
   confirm it once with `status.cjs` on a real machine. Claude Code uses its
   documented settings layout.
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
    "statusMessage": "Auto-commit checkpoint"
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

   Claude Code uses the same command-string family in its settings.json, plus a
   per-group `matcher` (unused for Stop but part of the documented schema; no
   `enabled` flag here either):

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "\"<bash>\" \"<script>/auto-commit.sh\"",
        "timeout": 30
      }]
    }]
  }
}
```

   Claude Code Stop payloads carry no `last_assistant_message`; the helper
   instead reads the JSONL transcript the payload's `transcript_path` points at
   and takes the last assistant text message. Commit-message model sources:
   ZCode reads `provider_config.json`, WorkBuddy uses its session loopback
   proxy, and Claude Code uses the session's `ANTHROPIC_BASE_URL` +
   `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`); the saved
   `llm-config.json` and `AUTOCOMMIT_LLM_*` overrides outrank all of them.

4. Backs up an existing config to `<config>.zcode-auto-commit.bak` and records
   the previous `hooks.enabled` value in the agent's `install-state.json`.
5. Refuses to install in both scopes unless `--force`; two installs would commit
   twice per turn. For workbuddy bash resolution prefers the bundled
   `CODEBUDDY_CODE_GIT_BASH_PATH`, then the usual Git installs.

## Verify

```bash
node scripts/status.cjs --scope workspace
```

Expect `installed`, `enabled: true`, scripts present, and `git: ok`.

- New sessions pick up the hook. Start a new session or reopen the workspace after
  installing.
- To run the installed hook manually (no model call):

```bash
printf '%s' '{"last_assistant_message":"test"}' \
  | ZCODE_PROJECT_DIR=/path/to/repo AUTOCOMMIT_NO_AI=1 \
    "<bash>" "$HOME/.zcode/hooks/auto-commit/auto-commit.sh"
git -C /path/to/repo log -1
```

  Claude Code variant — the payload points at a JSONL transcript whose last
  assistant text entry becomes the message source:

```bash
printf '%s' '{"transcript_path":"/path/to/transcript.jsonl"}' \
  | CLAUDE_PROJECT_DIR=/path/to/repo AUTOCOMMIT_NO_AI=1 \
    "<bash>" "$HOME/.claude/hooks/auto-commit/auto-commit.sh"
git -C /path/to/repo log -1
```

## Uninstall

`uninstall.cjs` removes only entries whose script is `auto-commit.sh`, preserves all
other hooks, restores the `hooks.enabled` value recorded at install, and deletes the
config file only if the installer created it and nothing else remains. `--purge`
removes the copied scripts when no remaining config references them.

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
- Workspace config lives under `.zcode/`. If that directory is not ignored, the
  auto-commit hook will commit the config file itself.
- The default scope is `user`, which applies to every project; use
  `--scope workspace` to limit the hook to a single repo.
- Review `.gitignore` before enabling. The hook never commits ignored files.

## Troubleshooting

- **Nothing commits**: run `status.cjs`. Confirm `hooks.enabled: true`, the configured
  bash exists, and `git rev-parse` works under the current user. If git reports
  `dubious ownership`, run:
  `git config --global --add safe.directory <repo>`
- **Generic message** (`chore: update N files`): the helper did not run, or no model
  provider is configured. Check the Node/Electron runtime and the provider config
  (`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, default `~/.zcode/v2/provider_config.json`):
  the first rule with a `baseUrl` and an `access.apiKey` wins (`providerId` is
  user-set and never used for selection); its `api.type` decides request style and
  auth (`anthropic-messages` and `openai-chat-completions` both supported), and
  models are tried in the rule's `modelOrder` order.
- **Double commits**: installed in both scopes; uninstall one.
- **Config parse error**: the installer refuses to edit invalid JSON. Fix the file or
  pass `--config <file>`.
- **WorkBuddy / other agents**: pass `--agent workbuddy` (config format verified
  against a real `.workbuddy/settings.json`). Other agents: the hook scripts are
  agent-agnostic — pass `--config <path>` if the target uses ZCode's
  `hooks.events` schema, or extend `lib.cjs` with another branch (see
  "Adding a new agent" below for the checklist).
- **Claude Code**: pass `--agent claude` (documented settings.json format).
  Without a model source (`ANTHROPIC_*` env, `llm-config.json` or
  `AUTOCOMMIT_LLM_*`) commits still happen but with generic heuristic messages.
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
   `hooks.events.<Event>[]`, process argv, `hooks.enabled`), `command-flat`
   (workbuddy — flat `hooks.<Event>[]`, quoted command string, whole-second
   timeout) and `command-flat-matcher` (claude — command-flat plus
   `matcher`). `eventArrays`/`isOurHook`/`stripOurHooks` iterate both known
   layouts, so same-family agents need nothing there.
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
   lists in `auto-commit.sh` if the agent bundles a Node/Electron runtime
   worth probing (Claude Code has none — PATH node suffices).

## Files

- `hooks/auto-commit.sh`, `hooks/auto-commit-msg.cjs` — installed verbatim
- `scripts/lib.cjs` — config merge, hook detection, bash discovery
- `scripts/install.cjs`, `scripts/uninstall.cjs`, `scripts/status.cjs`
- `scripts/setup-llm.cjs` — save/show/clear a manual LLM endpoint
  (`llm-config.json`); it outranks the session provider at runtime

To use this skill in every project, copy this directory to
`~/.agents/skills/auto-commit-hook/`.

After editing anything under `hooks/`, re-run `install.cjs` — the hook
executes the copies in `~/.zcode/hooks/auto-commit/` (or `~/.workbuddy/...`,
`~/.claude/...`),
not this directory; `install.sh` alone does not refresh them.
