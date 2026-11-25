# Failure visibility and troubleshooting

## Failure visibility

The hook always exits 0 and never blocks a turn, so failures are reported out
of band instead of aborting:

- Every real failure (missing git, `git add`/`git commit` errors, a sensitive
  file that could not be unstaged) overwrites `last-run.json` and appends to
  `auto-commit.log` in the agent's asset directory. The log is created lazily
  on the first failure; a successful commit only overwrites `last-run.json`
  with `status: "ok"`, so a healthy install usually has no log file. Timestamps
  (`at` here, `since` in the pause marker, and each log line) are ISO 8601 in
  the machine's local time with its numeric UTC offset, e.g.
  `2026-11-25T21:49:20+08:00`; no conversion is needed when comparing them with
  the clock or with host/provider logs.
- `status` prints that state: `last run: FAILED <time> (<stage>) <detail>`
  plus the log path; `--json` exposes the same object as `lastRun`. A run whose
  changed files were all excluded by the sensitive gate is recorded as
  `status: "ok"` with `skipped: "sensitive"` and prints as
  `last run: skipped <time> (sensitive)` — the commit was intentionally
  skipped, not failed, and `last-run.json` no longer describes an older turn.
- Claude Code additionally receives a non-blocking stdout payload
  `{"systemMessage":"⚠ auto-commit failed (...)","suppressOutput":true}`, which
  the UI shows immediately. Other hosts get no stdout by default (their hook
  output schema is not verified); set `AUTOCOMMIT_NOTIFY_STDOUT=1` to force the
  same JSON channel for testing.
- Expected skips — not a repository, clean tree, merge/rebase in progress,
  detached HEAD — are not failures and are never reported. A missing model
  also falls back to a file-list placeholder by design and is not a failure,
  but the attempt is recorded in `last-run.json` under `ai`: `ok` (source,
  model, duration), `disabled` (`AUTOCOMMIT_NO_AI=1`), `skipped` (empty agent
  reply), `unavailable` (the provider sources checked and why each was empty),
  or `error` (each model's HTTP/network/timeout failure). `status` prints it as
  an `ai:` line. Only the message is the placeholder; the commit itself
  succeeds.
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

- **Nothing commits**: check the `disabled:` line first — the hook may be
  paused, not broken. `run.sh enable` removes the marker and the next Stop runs
  again. Otherwise run `status --doctor`; it reports the configured bash,
  Claude `disableAllHooks` / `allowManagedHooksOnly`, and whether git can use
  the project. A `last run: FAILED ...` line names the failing stage and the log
  path. A `last run: skipped <time> (sensitive)` line means the sensitive gate
  excluded every changed file, so nothing was meant to be committed. On ZCode
  also confirm `hooks.enabled: true`; on Claude Code check workspace trust. If
  git reports `dubious ownership`, run:
  `git config --global --add safe.directory <repo>`
- **Generic or subject-only message**: no model produced a usable draft, so the
  message is the deterministic file list (`chore: update a.txt, b.txt and N
  more files`), or the helper did not run.
  `status` prints an `ai:` line: `disabled` for the message means
  `AUTOCOMMIT_NO_AI=1` / `noAi` (both model calls off); a `disabled` screen
  alone can also come from `AUTOCOMMIT_NO_AI_SCREEN` / `noAiScreen`.
  `skipped` means the Stop payload had no final message, `unavailable` lists
  every provider source checked and why it was empty, and `error` lists each
  model's HTTP/network/timeout failure. `last-run.json` has the same object
  under `ai`. For the ZCode source, also check the provider config
  (`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, default `~/.zcode/v2/provider_config.json`):
  the first rule with a `baseUrl` and an `access.apiKey` wins (`providerId` is
  user-set and never used for selection); its `api.type` decides request style and
  auth (`anthropic-messages` and `openai-chat-completions` both supported), and
  models are tried in the rule's `modelOrder` order.
  On Claude Code the `checked` list may also say
  `claude-cli: claude executable not found...`; an `error` attempt from that
  fallback shows `Not logged in`, `exit N` or `timeout after ... ms`.
- **Double commits**: installed in both scopes; uninstall one. On Claude Code
  also check both project files (`settings.json` and `settings.local.json`) —
  every merged copy runs; remove an old one with
  `--config .claude/settings.json`.
- **Config parse error**: the installer refuses to edit invalid JSON. Fix the file or
  pass `--config <file>`. For the runtime file, `config --show` reports an
  unreadable `config.json`; fix or rewrite it with `config --clear` followed by
  `config --url/--key/--model`.
- **WorkBuddy / other agents**: pass `--agent workbuddy` (config format verified
  against a real `.workbuddy/settings.json`). For other agents, the hook scripts
  are agent-agnostic — pass `--config <path>` if the target uses ZCode's
  `hooks.events` schema.
- **Claude Code**: pass `--agent claude` (workspace scope writes
  `.claude/settings.local.json`; user scope writes `~/.claude/settings.json`).
  Message sources, in order: a complete manual endpoint in `config.json`
  (`url` + `key` + `model`) with `AUTOCOMMIT_LLM_*` env overrides on top; the
  session's `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY`
  (models from `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, then
  `CLAUDE_CODE_MODEL_CAPABILITIES`); and, when neither is usable, `claude -p`
  with the CLI's own login. The hook never reads credential files or the
  Keychain, and does not use `--bare` (it refuses OAuth). The `ai:` line shows
  `transport: http|cli` plus the sources checked.
  The CLI child runs in a temporary cwd; `--settings` disables all hooks and
  `AUTOCOMMIT_IN_HOOK=1` makes any Stop it fires exit before git work, so a
  nested commit cannot happen. If an `ai:` attempt says `Not logged in`, run
  `/login` in Claude Code and let the next turn retry — the commit already
  succeeded with the file-list placeholder. The CLI already runs on haiku
  (fixed); if it is
  still slow, raise `AUTOCOMMIT_AI_TOTAL_MS` (keep it below the hook timeout; the
  installer's default is 30 s). If nothing commits, check that the project is
  trusted, no merged settings file sets `disableAllHooks` /
  `allowManagedHooksOnly` (`status --doctor` reports them), and the registered
  bash path still exists.
- **Mixed agents**: the hook scripts detect their host at runtime (env-var
  prefixes), so the same install works under any supported host; `--agent` only
  selects where the hook is registered and in which format.
