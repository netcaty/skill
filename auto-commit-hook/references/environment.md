# Environment overrides

All optional. The hook scripts read these on each Stop; unset values fall back
to the defaults shown.

| variable | effect |
|---|---|
| `AUTOCOMMIT_INSTALL_DIR` | installed skill directory (default `~/.agents/skills/auto-commit-hook`) |
| `AUTOCOMMIT_NODE` | Node runtime for `run.sh` |
| `AUTOCOMMIT_BASH` | bash executable registered in the hook |
| `AUTOCOMMIT_NO_AI=1` | skip the model call; use a heuristic message |
| `AUTOCOMMIT_LLM_URL` / `_KEY` / `_MODEL` | override the saved LLM config |
| `AUTOCOMMIT_LLM_CONFIG` | alternate `llm-config.json` path |
| `AUTOCOMMIT_CLAUDE_BIN` | explicit `claude` executable for the CLI fallback (default: `CLAUDE_CODE_EXECPATH`, then `PATH`) |
| `AUTOCOMMIT_AI_TIMEOUT_MS` / `_TOTAL_MS` | per-model / overall model budget; defaults are 8000/13000 ms over HTTP and 18000/20000 ms for the `claude -p` fallback |
| `AUTOCOMMIT_NOTIFY_STDOUT=1` | force the failure-notification JSON channel for testing; see [troubleshooting](troubleshooting.md) |
| `AUTOCOMMIT_SOURCE_DIR` | source checkout for `status --update` |
| `AUTOCOMMIT_NO_SKILL_LINK=1` | skip the `<skills-dir>` link in `install.sh` |
| `CODEBUDDY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` / `ZCODE_PROJECT_DIR` | session project used by workspace scope, in that order |

`AUTOCOMMIT_LLM_*` outranks a saved `llm-config.json`, which outranks the host's
session provider.
