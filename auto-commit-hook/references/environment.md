# Configuration and environment

The user config file is `<skill-dir>/config.json` (default
`~/.agents/skills/auto-commit-hook/config.json`; override the path with
`AUTOCOMMIT_CONFIG`). Only `bash scripts/run.sh config ...` writes it; the hook
reads it and never writes it.

Priority is per key: **environment variable > config.json > default/session
provider**. Environment variables suit CI and tests; `config.json` suits daily
use.

## Config-able settings

| config key | environment variable | default | effect |
|---|---|---|---|
| `url` | `AUTOCOMMIT_LLM_URL` | session provider | manual endpoint; used only with `key` + `model` |
| `key` | `AUTOCOMMIT_LLM_KEY` | session provider | manual endpoint key; masked by `config --show` |
| `model` | `AUTOCOMMIT_LLM_MODEL` | provider/session model | env comma list; file array or comma string, tried in order |
| `noAi` | `AUTOCOMMIT_NO_AI` | `false` | skip both model calls; `1/true/yes/on` disable, `0/false/no/off` explicitly enable and override the file |
| `claudeBin` | `AUTOCOMMIT_CLAUDE_BIN` | `CLAUDE_CODE_EXECPATH`, then `PATH` | explicit `claude` executable for the CLI fallback |
| `aiTimeoutMs` | `AUTOCOMMIT_AI_TIMEOUT_MS` | 8000 HTTP / 18000 CLI | per-model, per-call budget (1000–3600000 ms) |
| `aiTotalMs` | `AUTOCOMMIT_AI_TOTAL_MS` | 13000 HTTP / 20000 CLI | budget per model task (1000–3600000 ms) |
| `sourceDir` | `AUTOCOMMIT_SOURCE_DIR` | `.source.json` record | source checkout for `status --update` |

`config.json` is a settings overlay, not a provider declaration. A complete
`url` + `key` + `model` trio is the manual endpoint; a file with only settings
(for example `{ "noAi": true }` or `{ "aiTimeoutMs": 12000 }`) leaves the
host's session provider in charge.

Invalid values are ignored with a diagnostic and the next layer is used; they
never block a turn. `config --set` rejects invalid explicit input instead.

## Environment-only settings

| variable | effect |
|---|---|
| `AUTOCOMMIT_CONFIG` | alternate `config.json` path (tests, non-default installs) |
| `AUTOCOMMIT_INSTALL_DIR` / `_ARCHIVE` / `_MODE` | `install.sh` staging (read before `config.json` exists) |
| `AUTOCOMMIT_NODE` | Node runtime for `run.sh` |
| `AUTOCOMMIT_BASH` | bash executable registered in the hook |
| `AUTOCOMMIT_NO_SKILL_LINK=1` | skip the agent skill links in `install.sh` |
| `AUTOCOMMIT_NOTIFY_STDOUT=1` | force the failure-notification JSON channel (testing) |
| `AUTOCOMMIT_PROVIDER_CONFIG` | alternate ZCode `provider_config.json` path |
| `AUTOCOMMIT_STATE_DIR` | state/log directory (testing) |
| `AUTOCOMMIT_IN_HOOK=1` | internal recursion guard |
| `AUTOCOMMIT_AGENT` | host agent id injected by `auto-commit.sh` |

These stay environment-only because they run before the config file exists
(install/bootstrap), locate the config file itself, or are test/diagnostic
internals.

## Host-provided session variables

Read but not user settings: `WORKBUDDY_VLM_*`, `ZCODE_*`, `ANTHROPIC_*`,
`CLAUDE_*`, `CODEBUDDY_*`, and `CODEBUDDY_PROJECT_DIR` /
`CLAUDE_PROJECT_DIR` / `ZCODE_PROJECT_DIR` / `WORKBUDDY_PROJECT_DIR`.
