# Safety

The full behaviour list behind the short summary in `SKILL.md`.

- The hook runs `git add -A` every turn: all tracked/untracked, non-ignored changes
  are committed, including pre-existing user changes.
- Sensitive files get a two-layer gate before the commit. Layer 1 (deterministic)
  unstages obvious secret names — `.env*` (except `.env.example`-style), key/cert
  extensions (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.kdbx`),
  `id_rsa`-style SSH keys, `credentials*`/`secrets*` data files, service-account
  JSON, and `.npmrc`/`.pypirc`/`.netrc`. Layer 2 has a deterministic half that
  scans the staged diff's added lines for high-confidence secret formats
  (private-key blocks, AWS/GitHub/OpenAI/Slack/Google token shapes,
  credentials-in-URL) and a best-effort half that runs a separate,
  recall-biased screening call over the staged paths and the added lines (a
  dedicated request, so it can neither truncate nor break the message call and
  vice versa). The deterministic half runs
  whenever the helper runs, including with `AUTOCOMMIT_NO_AI=1`, when the model
  is unavailable or times out, and when the agent reply is empty; only the
  model half can be absent (and a missing JavaScript runtime leaves just
  layer 1). The `ai` record in `last-run.json` says which screen ran and how
  many paths it excluded (`status` prints it). Staged paths are exchanged as
  exact, NUL-separated git output, so non-ASCII names are neither quoted nor
  lost, and
  a path is reported as excluded only after `git diff --cached` confirms it
  left the index. Excluded paths are not named in the commit message; they
  remain visible as uncommitted files in the worktree. This is not a security
  boundary: the content scan recognizes known formats only, a secret carried
  through a pure rename is not re-scanned, and flagged paths are always
  resolved against the real staged list, so a hallucinated path can never
  unstage anything.
- It uses `--no-verify` and disables GPG signing for that commit.
- The hook can be paused without editing any agent config: `run.sh disable`
  writes a `disabled.json` marker into the asset directory and the script exits
  before any git work; `run.sh enable` removes it. Refreshing the assets
  (`install`) keeps the marker; uninstalling clears it.
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
- On Claude Code without a usable endpoint, the message helper runs `claude -p`.
  That child runs in the OS temp directory with all hooks disabled through an
  added settings layer and tools off where supported; session markers are
  removed and `AUTOCOMMIT_IN_HOOK=1` is set, so a Stop event it fires exits
  before any git work. The hook itself never reads
  `~/.claude/.credentials.json` or the Keychain — authentication is the CLI's
  own.
- Workspace config lives under `.zcode/`. If that directory is not ignored, the
  auto-commit hook will commit the config file itself.
- Claude Code merges hooks from user settings, project `settings.json` and
  project `settings.local.json`; every registered copy runs. Register the hook
  in one file only — `install.cjs` refuses another merged file that already has
  it, so do not also add it by hand to `settings.json`.
- Claude Code's `disableAllHooks` / `allowManagedHooksOnly` (in any merged
  settings file) stop the hook from running; `install.cjs` and `status --doctor`
  warn when they see them. Project-level hooks also require workspace trust.
- On Claude Code, `Stop` also fires on user interrupt, `/clear` and after
  compaction, so those end-of-turn events can produce a checkpoint commit too.
- The default scope is `user`, which applies to every project; use
  `--scope workspace` to limit the hook to a single repo.
- Review `.gitignore` before enabling. The hook never commits ignored files.
