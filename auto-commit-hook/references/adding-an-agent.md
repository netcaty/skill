# Adding a new agent (e.g. dsh)

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
6. Update the config table and hook JSON example in
   `install-internals.md`, the `--agent` help lines in the three scripts, and
   the runtime candidate lists in `hooks/auto-commit.sh` and `scripts/run.sh`
   — keep those two in sync — if the agent bundles a Node/Electron runtime
   worth probing (Claude Code has none — PATH node suffices).
