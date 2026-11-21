---
name: auto-commit-hook
description: >-
  Install, uninstall, inspect, or troubleshoot the automatic git checkpoint Stop hook
  (auto-commit) for ZCode/WorkBuddy workspaces. Use when the user asks to enable or
  disable auto-commit, install or remove the Stop hook, set up per-turn git
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
(default) or `--scope workspace`. The agent (`zcode` or `workbuddy`) is
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
```

If `node` is not on `PATH`, run the same script with the agent's Electron runtime:

```bash
# ZCode
ELECTRON_RUN_AS_NODE=1 "$ZCODE_WINDOWS_APP_INSTALL_DIR/ZCode.exe" scripts/install.cjs --scope workspace

# WorkBuddy (--agent because a plain shell has no WorkBuddy env to auto-detect)
ELECTRON_RUN_AS_NODE=1 "$WB_SHT_INSTDIR/WorkBuddy.exe" scripts/install.cjs --agent workbuddy
```

Without the agent's env vars, the executables live in
`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` and
`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`; the hook scripts probe these
same paths at runtime.

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

## What install does

1. Copies `hooks/auto-commit.sh` and `hooks/auto-commit-msg.cjs` to the agent's
   asset directory: `~/.zcode/hooks/auto-commit/` (zcode) or
   `~/.workbuddy/hooks/auto-commit/` (workbuddy).
2. Merges a `Stop` entry into the selected config:

   | agent | workspace | user |
   |---|---|---|
   | zcode | `<repo>/.zcode/config.json` | `~/.zcode/cli/config.json` |
   | workbuddy | `<repo>/.workbuddy/settings.json` | `~/.workbuddy/settings.json` |

   WorkBuddy's user-scope file name follows the verified project-level layout;
   confirm it once with `status.cjs` on a real machine.
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
  both `anthropic-messages` and `openai-chat-completions` rules with a `baseUrl` and
  an `access.apiKey` are used, models from the rule's `modelOrder`.
- **Double commits**: installed in both scopes; uninstall one.
- **Config parse error**: the installer refuses to edit invalid JSON. Fix the file or
  pass `--config <file>`.
- **WorkBuddy / other agents**: pass `--agent workbuddy` (config format verified
  against a real `.workbuddy/settings.json`). Other agents: the hook scripts are
  agent-agnostic — pass `--config <path>` if the target uses ZCode's
  `hooks.events` schema, or extend `lib.cjs` with another branch.
- **Mixed agents**: the hook scripts detect their host at runtime (env-var
  prefixes), so the same install works under either desktop app; `--agent` only
  selects where the hook is registered and in which format.

## Files

- `hooks/auto-commit.sh`, `hooks/auto-commit-msg.cjs` — installed verbatim
- `scripts/lib.cjs` — config merge, hook detection, bash discovery
- `scripts/install.cjs`, `scripts/uninstall.cjs`, `scripts/status.cjs`

To use this skill in every project, copy this directory to
`~/.agents/skills/auto-commit-hook/`.
