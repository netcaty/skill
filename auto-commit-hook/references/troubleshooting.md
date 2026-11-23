# Failure visibility and troubleshooting

## Failure visibility

The hook always exits 0 and never blocks a turn, so failures are reported out
of band instead of aborting:

- Every real failure (missing git, `git add`/`git commit` errors, a sensitive
  file that could not be unstaged) overwrites `last-run.json` and appends to
  `auto-commit.log` in the agent's asset directory. The log is created lazily
  on the first failure; a successful commit only overwrites `last-run.json`
  with `status: "ok"`, so a healthy install usually has no log file.
- `status` prints that state: `last run: FAILED <time> (<stage>) <detail>`
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

## Run the hook by hand

No model call is made with `AUTOCOMMIT_NO_AI=1`:

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

## Troubleshooting

- **Nothing commits**: run `status --doctor`; it reports the configured bash,
  Claude `disableAllHooks` / `allowManagedHooksOnly`, and whether git can use
  the project. A `last run: FAILED ...` line names the failing stage and the log
  path. On ZCode also confirm `hooks.enabled: true`; on Claude Code check
  workspace trust. If git reports `dubious ownership`, run:
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
  `adding-an-agent.md`).
- **Claude Code**: pass `--agent claude` (workspace scope writes
  `.claude/settings.local.json`; user scope writes `~/.claude/settings.json`).
  The commit-message model comes from the session's `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` and, in order, `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`,
  then the ids in `CLAUDE_CODE_MODEL_CAPABILITIES`; a saved `llm-config.json`
  or `AUTOCOMMIT_LLM_*` outranks them. Without any model source commits still
  happen but with generic heuristic messages. If nothing commits, check that
  the project is trusted, no merged settings file sets `disableAllHooks` /
  `allowManagedHooksOnly` (`status --doctor` reports them), and the registered
  bash path still exists.
- **Mixed agents**: the hook scripts detect their host at runtime (env-var
  prefixes), so the same install works under any supported host; `--agent` only
  selects where the hook is registered and in which format.
