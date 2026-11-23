# Install internals

What `install.cjs` writes when it registers the Stop hook. The commands themselves
are in `SKILL.md`; this file is the reference for config locations and formats.

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
   `AUTOCOMMIT_LLM_*` overrides outrank all of them. How the message was
   produced — including why no model was used or which model calls failed — is
   recorded under `ai` in `last-run.json`; see
   [troubleshooting](troubleshooting.md).
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

## Files

Everything under `hooks/` and `scripts/` is installed verbatim; see the commands
in `SKILL.md` for what each script does.

`run.sh disable` writes `<asset dir>/disabled.json`; `auto-commit.sh` checks it
before any git work, so pausing needs no config rewrite and takes effect on the
next Stop. `install` preserves the marker (asset refreshes must not silently
resume a paused hook) and `uninstall` removes it; `status` reports it as a
`disabled:` line.

The hook always executes the asset copies in `~/.zcode/hooks/auto-commit/`
(or `~/.workbuddy/...`, `~/.claude/...`) — never this directory — which is why
refreshing takes both steps in "Update the installed skill" in `SKILL.md`, and
why `install.sh` alone does not refresh the hook.
