#!/usr/bin/env node
// ZCode auto-commit message generator, called by auto-commit.sh.
//
// stdin : Stop hook JSON payload - the last_assistant_message field is read;
//         when the payload instead carries a transcript_path (Claude Code),
//         the last assistant text message is extracted from that JSONL
//         transcript; everything else in the payload is ignored.
// env   : CHANGED_FILE                changed file paths, NUL separated, from
//                                     `git diff --cached --name-only -z`; the
//                                     exact git spelling, so paths with
//                                     non-ASCII bytes or spaces still match
//         DIFF_FILE                    file holding the staged diff (HEAD vs
//                                     index, pre-clipped by the shell). Screen
//                                     input for both the deterministic secret
//                                     scan below and the model layer
//         SENSITIVE_OUT                output file: newline-separated staged
//                                     paths to unstage. Holds the deterministic
//                                     content-scan hits plus any path the model
//                                     flagged; it is written even when the
//                                     model is disabled, unavailable or fails,
//                                     so screening never silently disappears
//         AI_STATUS_OUT                output file: compact JSON describing how
//                                     the commit message was produced (status
//                                     ok | disabled | skipped | unavailable |
//                                     error, provider source, model, timings,
//                                     checked sources or per-model errors), plus
//                                     a "sensitive" summary of the screening
//                                     call and the deterministic scan;
//                                     auto-commit.sh embeds it verbatim as the
//                                     "ai" field of last-run.json
//         AUTOCOMMIT_AGENT             agent type from auto-commit.sh (zcode |
//                                     workbuddy | codebuddy:* | claude |
//                                     unknown); selects the model source below
//         WORKBUDDY_VLM_CHAT_URL / _AUTH_TOKEN / _CONTEXT
//                                     loopback chat proxy the WorkBuddy desktop
//                                     app injects into each session; used when
//                                     the agent is workbuddy/codebuddy (or, for
//                                     unknown agents, when all three are set)
//         ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
//                                     session provider config ZCode injects into
//                                     the hook env; the zcode path follows it so
//                                     the hook runs on the same provider the
//                                     session itself uses. The first rule with a
//                                     baseUrl and an access.apiKey wins (id is
//                                     user-set, never used for selection); its
//                                     api.type decides request style and auth
//                                     (anthropic-messages and
//                                     openai-chat-completions both supported),
//                                     models are tried in modelOrder order
//         ANTHROPIC_BASE_URL / _AUTH_TOKEN / _API_KEY
//                                     the Claude Code session's Anthropic
//                                     endpoint; used when the agent is claude
//                                     (or, for unknown agents, when the other
//                                     sources are unavailable). There is no
//                                     provider config file on the Claude Code
//                                     side. Without these (or a complete
//                                     manual endpoint in config.json) the
//                                     claude path falls back to the local
//                                     `claude -p` below.
//         claude -p fallback          when no direct endpoint credentials exist,
//                                     the helper runs the installed Claude Code
//                                     CLI and lets it authenticate from its own
//                                     login (subscription OAuth or whatever the
//                                     CLI is configured with). The hook never
//                                     reads credential files or the Keychain,
//                                     and never uses --bare (which refuses
//                                     OAuth). The child runs in a temporary cwd,
//                                     with tools off where supported, an added
//                                     settings layer disabling all hooks, and
//                                     AUTOCOMMIT_IN_HOOK=1 so any Stop event it
//                                     might still fire is a no-op. Always asks
//                                     for --model haiku (fixed, not
//                                     configurable): a commit message does not
//                                     need a larger model
//         ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL /
//         ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL /
//         CLAUDE_CODE_MODEL_CAPABILITIES
//                                     Claude Code model candidates, tried in
//                                     that order. Real sessions often set only
//                                     the DEFAULT_* mappings and the
//                                     capabilities list, never ANTHROPIC_MODEL
//                                     itself
//         AUTOCOMMIT_CONFIG            alternate config.json path
//         AUTOCOMMIT_NO_AI             disable both model calls (the
//                                     deterministic content scan still runs);
//                                     1/true/yes/on disable, 0/false/no/off
//                                     explicitly enable and override config
//         AUTOCOMMIT_PROVIDER_CONFIG   override provider_config.json path
//         AUTOCOMMIT_LLM_URL / _KEY    endpoint overrides
//         AUTOCOMMIT_LLM_MODEL         comma-separated candidate models; default
//                                     is the provider's modelOrder (ZCode), the
//                                     session model env (WorkBuddy) or
//                                     ANTHROPIC_MODEL (claude), tried in order
//                                     until one succeeds. Does not affect the
//                                     claude -p fallback, which always uses
//                                     haiku
//         AUTOCOMMIT_CLAUDE_BIN        explicit claude executable for the
//                                     fallback; default is config.json
//                                     claudeBin, then CLAUDE_CODE_EXECPATH,
//                                     then a PATH lookup
//         AUTOCOMMIT_AI_TIMEOUT_MS     per-model timeout, per call (default 8000
//                                     over HTTP, 18000 for claude -p)
//         AUTOCOMMIT_AI_TOTAL_MS       budget per call (default 13000 over HTTP,
//                                     20000 for claude -p); the call runs in
//                                     parallel with the other one
//
// config.json (written by scripts/config.cjs, read-only here) carries the same
// runtime settings as flat keys — url, key, model, noAi, claudeBin,
// aiTimeoutMs, aiTotalMs — and each environment variable above outranks its
// config key. A complete url+key+model trio is the manual endpoint; the other
// keys are settings only and never change which provider is selected.
// stdout: the commit message text, or nothing when no model produced a usable
//         draft; auto-commit.sh then writes the file-list fallback ("chore:
//         update ...") from the index left after both exclusion layers.
//
// Each turn makes two independent model calls, started together:
//   - message: the agent's final reply -> Conventional Commits subject + body
//     (small, no diff, 600 output tokens);
//   - screening: staged paths + added lines only -> sensitiveFiles, with a
//     recall-biased policy and a small output budget. It is a separate call so
//     it cannot truncate or break the message, and vice versa; its outcome is
//     recorded under "sensitive" and never blocks the message path.
// Any model failure leaves the message to the shell's deterministic file list;
// the deterministic screening always runs, so the hook never blocks the turn.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];

// claude -p fallback: budgets and output caps. The child is a full CLI
// cold-start, so it gets a longer budget than the HTTP path while still
// leaving the 30 s host hook timeout room for git work.
const CLI_STDOUT_CAP = 1024 * 1024;
const CLI_STDERR_CAP = 16 * 1024;
const CLI_ATTEMPT_DEFAULT = 18000;
const CLI_TOTAL_DEFAULT = 20000;
const CLI_MIN_RETRY_MS = 6000;
const CLI_SETTINGS = { disableAllHooks: true };

// Session markers that must not leak into the nested CLI. CLAUDECODE and the
// entrypoint/session ids can make the CLI think it is running inside another
// session (some versions refuse that); the rest are parent-session plumbing.
const CLI_ENV_DROP = [
  "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_CHILD_NOTES_DIR", "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT", "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_AUTO_MODE_SERVER", "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  "ELECTRON_RUN_AS_NODE",
  "WORKBUDDY_VLM_AUTH_TOKEN", "WORKBUDDY_VLM_CONTEXT"
];

// ---------------------------------------------------------------------------
// User configuration — <skill-dir>/config.json. Read-only here: only
// scripts/config.cjs writes the file. Priority is per key:
// environment variable > config.json > default/session provider.
//
// This script ships standalone (the agent asset dir has no scripts/lib.cjs),
// so the reader duplicates the one in scripts/lib.cjs on purpose; keep the
// parsing and validation rules in sync.
// ---------------------------------------------------------------------------
const USER_CONFIG_BASENAME = "config.json";
const USER_CONFIG_MAX_BYTES = 64 * 1024;
const USER_CONFIG_MS_MIN = 1000;
const USER_CONFIG_MS_MAX = 3600000;

function userConfigFile() {
  if (process.env.AUTOCOMMIT_CONFIG) return path.resolve(process.env.AUTOCOMMIT_CONFIG);
  return path.join(os.homedir(), ".agents", "skills", "auto-commit-hook", USER_CONFIG_BASENAME);
}

// Never throws. A malformed or unreadable file is treated as absent so the
// hook fails open.
function readUserConfig() {
  const file = userConfigFile();
  const result = { file, exists: false, data: {}, error: "" };
  let raw;
  try {
    if (fs.statSync(file).size > USER_CONFIG_MAX_BYTES) {
      result.error = "config.json is larger than 64 KiB: " + file;
      return result;
    }
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code !== "ENOENT") result.error = "config.json not readable: " + file;
    return result;
  }
  result.exists = true;
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return result;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    result.error = "config.json is not valid JSON: " + file;
    return result;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    result.error = "config.json is not a JSON object: " + file;
    return result;
  }
  result.data = data;
  return result;
}

function normalizeModels(value) {
  const list = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
  return list.map(item => String(item).trim()).filter(Boolean);
}

function normalizeEnvBoolean(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function parseMs(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= USER_CONFIG_MS_MIN && value <= USER_CONFIG_MS_MAX
      ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const ms = Number(value.trim());
    return ms >= USER_CONFIG_MS_MIN && ms <= USER_CONFIG_MS_MAX ? ms : null;
  }
  return null;
}

// Resolve every runtime setting once: env > config.json > default/session.
// Invalid values are skipped with a problem string, never thrown.
function runtimeSettings() {
  const read = readUserConfig();
  const data = read.data || {};
  const problems = [];
  if (read.error) problems.push(read.error);

  const envString = name => {
    const raw = process.env[name];
    return raw !== undefined && String(raw).trim() ? String(raw).trim() : "";
  };
  const cfgString = key =>
    typeof data[key] === "string" && data[key].trim() ? data[key].trim() : "";

  // Manual endpoint: env overrides win per key; all three are required, and a
  // settings-only file must not affect the session provider.
  const url = envString("AUTOCOMMIT_LLM_URL") || cfgString("url");
  const key = envString("AUTOCOMMIT_LLM_KEY") || cfgString("key");
  let models = [];
  const envModel = envString("AUTOCOMMIT_LLM_MODEL");
  if (envModel) {
    models = envModel.split(",").map(s => s.trim()).filter(Boolean);
  } else if (data.model !== undefined) {
    models = normalizeModels(data.model);
    if (!models.length) problems.push("config.json model is empty or malformed");
  }
  const manualIncomplete = !(url && key && models.length) &&
    !!(data.url !== undefined || data.key !== undefined || data.model !== undefined);
  const manual = url && key && models.length
    ? { url, key, models, kind: /\/messages(\/?)$/i.test(url) ? "zcode-anthropic" : undefined }
    : null;

  const envNoAi = normalizeEnvBoolean("AUTOCOMMIT_NO_AI");
  let noAi;
  if (envNoAi !== null) noAi = { value: envNoAi, source: "env" };
  else if (typeof data.noAi === "boolean") noAi = { value: data.noAi, source: "config" };
  else {
    if (data.noAi !== undefined) problems.push("config.json noAi is not a boolean");
    noAi = { value: false, source: "default" };
  }

  const envMs = name => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return null;
    const ms = parseMs(raw);
    if (ms === null) problems.push(name + " is not a valid millisecond budget; ignored");
    return ms;
  };
  const cfgMs = key => {
    if (data[key] === undefined) return null;
    const ms = parseMs(data[key]);
    if (ms === null) {
      problems.push("config.json " + key + " is not a valid millisecond budget; ignored");
    }
    return ms;
  };

  return {
    file: read.file,
    exists: read.exists,
    error: read.error,
    problems,
    manual,
    manualIncomplete,
    noAi,
    claudeBin: envString("AUTOCOMMIT_CLAUDE_BIN") || cfgString("claudeBin"),
    aiTimeoutMs: envMs("AUTOCOMMIT_AI_TIMEOUT_MS") ?? cfgMs("aiTimeoutMs"),
    aiTotalMs: envMs("AUTOCOMMIT_AI_TOTAL_MS") ?? cfgMs("aiTotalMs")
  };
}

// Null when AI is enabled; otherwise the diagnostic reason. The env reason
// string stays exactly "AUTOCOMMIT_NO_AI=1" (status output and tests rely on it).
function noAiReason(settings) {
  const resolved = settings || runtimeSettings();
  if (!resolved.noAi.value) return null;
  return resolved.noAi.source === "env"
    ? "AUTOCOMMIT_NO_AI=1"
    : "config.json noAi=true";
}

// Fallback message source: hosts or versions whose Stop payload omits
// last_assistant_message point at a JSONL transcript instead. Scan backwards
// from the end for the last main-chain assistant entry that actually has text
// (tool_use-only and thinking-only entries, plus subagent sidechains, are
// skipped). Only the tail of the file is read so a long session cannot balloon
// the hook runtime.
function lastAssistantFromTranscript(file) {
  let path = String(file || "");
  // Windows node cannot stat Git-Bash style /c/... paths; hand-written
  // payloads and debugging scripts sometimes use them. Real agent payloads
  // send native paths, so this is only a fallback.
  if (process.platform === "win32") {
    const m = /^\/([a-z])\/(.*)$/i.exec(path);
    if (m) path = m[1].toUpperCase() + ":/" + m[2];
  }
  let text = "";
  try {
    const size = fs.statSync(path).size;
    const tail = Math.min(size, 4 * 1024 * 1024);
    const fd = fs.openSync(path, "r");
    try {
      const buf = Buffer.alloc(tail);
      fs.readSync(fd, buf, 0, tail, size - tail);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.type !== "assistant" || entry.isSidechain) continue;
    const content = entry.message && entry.message.content;
    const out = Array.isArray(content)
      ? content.filter(b => b && b.type === "text" && typeof b.text === "string")
        .map(b => b.text).join("\n")
      : (typeof content === "string" ? content : "");
    if (out.trim()) return out;
  }
  return "";
}

function parsePayload(raw) {
  let payload = {};
  try { payload = JSON.parse(String(raw || "{}")) || {}; } catch {}
  const direct = String(payload.last_assistant_message || "");
  if (direct) return direct.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (payload.transcript_path) {
    return lastAssistantFromTranscript(String(payload.transcript_path))
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  }
  return "";
}

function readPayload() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  return parsePayload(raw);
}

function cleanLine(line) {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:已完成|完成|改动|变更|修改|更新|处理)\s*[:：]\s*/, "")
    .replace(/[：:;；,，.。]+$/, "");
}

function inferTypeFromText(text) {
  const lower = text.toLowerCase();
  const rules = [
    ["revert", /回滚|撤销|\brevert\b/],
    ["feat", /新增|添加|实现|支持|引入|增加|创建|\bfeat\b|\bfeature\b/],
    ["fix", /修复|修正|解决|纠正|故障|崩溃|报错|缺陷|\bbug\b|\bfix\b/],
    ["perf", /性能|加速|吞吐|延迟|\bperf\b/],
    ["refactor", /重构|重写|拆分|简化|提取|解耦|\brefactor\b/],
    ["docs", /文档|注释|\breadme\b|\bdocs?\b/],
    ["test", /测试|用例|\btests?\b|\bspecs?\b/],
    ["build", /构建|依赖|\blockfile\b|\bwebpack\b|\bvite\b|\brollup\b|\bdocker\b|\bbuild\b/],
    ["ci", /\bci\b|流水线|\bworkflow\b|github actions/],
    ["style", /格式|排版|缩进|\blint\b|\bprettier\b|\beslint\b|\bstyle\b/],
    ["chore", /杂项|清理|配置|脚本|\bchore\b/]
  ];
  let best = Infinity;
  let type = "";
  for (const [t, re] of rules) {
    const i = lower.search(re);
    if (i >= 0 && i < best) { best = i; type = t; }
  }
  if (!type && /优化[^，。；;\n]{0,10}(?:代码|结构|逻辑|实现|流程|架构|模块)/.test(lower)) {
    type = "refactor";
  }
  return type;
}

// Staged paths in their exact git spelling. CHANGED_FILE is NUL separated and
// therefore survives non-ASCII names, spaces and quotes; there is no
// newline-separated fallback because that format cannot represent them.
function changedFiles() {
  const file = process.env.CHANGED_FILE;
  if (!file) return [];
  try {
    return fs.readFileSync(nativePath(file), "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function readDiff() {
  const file = process.env.DIFF_FILE;
  if (!file) return "";
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// --- sensitive-content gate, layer 2 ---------------------------------------
// Two sources feed SENSITIVE_OUT: a deterministic scan of added diff lines
// (runs even when the model is unavailable) and the model's own judgement.
// Every reported path is resolved against the exact staged list, so neither a
// hallucinated path nor a diff header can unstage anything that is not staged.
const MAX_SENSITIVE = 50;

// Only high-confidence signatures. A deterministic hit unstages a file from
// every checkpoint, so generic `password = "..."`-style patterns would drop
// ordinary code and fixtures; judgement calls stay with the model.
const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  // Credentials in a URL, but not the placeholder passwords docs use
  // (`user:password@host`). Redis often leaves the user part empty.
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^\s:@/]*:(?!password\b|passwd\b|secret\b|changeme\b|example\b)[^\s@/]{8,}@/i
];

// The model may answer with Windows separators, a "./" prefix or different
// case; git always reports forward slashes and the recorded spelling.
function normalizeRepoPath(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
}

function pathKey(file) {
  const p = normalizeRepoPath(file);
  return process.platform === "win32" ? p.toLowerCase() : p;
}

// Resolve reported paths to the exact staged spelling. Unmatched entries are
// counted (not echoed into last-run.json) so a separator/case mismatch is
// visible as a diagnostic instead of looking like "nothing sensitive".
function matchStaged(values) {
  const staged = new Map();
  for (const file of changedFiles()) {
    const key = pathKey(file);
    if (!staged.has(key)) staged.set(key, file);
  }
  const seen = new Set();
  const files = [];
  const unmatched = [];
  for (const value of (Array.isArray(values) ? values : [])) {
    const raw = String(value == null ? "" : value).trim();
    if (!raw) continue;
    // The path itself wins; a model that saw a rename diff may instead answer
    // "old -> new", so both sides are tried as a fallback.
    const arrow = raw.indexOf("->");
    const candidates = arrow >= 0
      ? [raw, raw.slice(0, arrow), raw.slice(arrow + 2)]
      : [raw];
    let hit = "";
    for (const candidate of candidates) {
      hit = staged.get(pathKey(candidate)) || "";
      if (hit) break;
    }
    if (!hit) {
      if (unmatched.length < 20) unmatched.push(clip(raw, 200));
      continue;
    }
    const key = pathKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(hit);
  }
  return { files, unmatched };
}

// Layer 2a (model): paths the model flagged as containing sensitive content.
function collectSensitive(obj) {
  return matchStaged(obj && obj.sensitiveFiles);
}

// Split a unified diff into per-file lists of added lines. A `+++` line is a
// header only directly after its `---` pair, and `+` lines count only inside a
// hunk, so added content that itself begins with "+++ " is not mistaken for a
// header. The diff is generated with core.quotePath=false, so non-ASCII paths
// stay byte-for-byte comparable with the staged names.
function parseDiffAdditions(diff) {
  const files = [];
  let current = null;
  let inHunk = false;
  let minusHeader = false;
  for (const line of String(diff || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      minusHeader = false;
      current = null;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("@@")) { inHunk = true; minusHeader = false; continue; }
      if (line.startsWith("--- ")) { minusHeader = true; continue; }
      if (line.startsWith("+++ ") && minusHeader) {
        const header = line.slice(4).replace(/\t$/, "");
        current = null;
        if (header !== "/dev/null") {
          current = { path: header.replace(/^b\//, ""), lines: [] };
          files.push(current);
        }
      }
      minusHeader = false;
      continue;
    }
    if (current && line.startsWith("+")) current.lines.push(line.slice(1));
  }
  return files;
}

// Layer 2b (deterministic): scan added lines for known secret formats.
function scanSensitiveDiff(diff) {
  const hits = [];
  for (const file of parseDiffAdditions(diff)) {
    if (file.lines.some(line => SENSITIVE_PATTERNS.some(re => re.test(line)))) {
      hits.push(file.path);
    }
  }
  return matchStaged(hits).files;
}

// Model screening input: added lines only, grouped by file. A unified diff
// spends most of its characters on context lines and headers, so this view
// covers far more files in the same prompt budget. Paths with no added lines
// (deletions, pure renames, binaries) are absent - the screen can still flag
// them by name from FILE_LIST.
const SCREEN_VIEW_CAP = 12000;

function addedLinesView(diff, cap) {
  const limit = cap || SCREEN_VIEW_CAP;
  const blocks = [];
  let used = 0;
  let truncated = false;
  for (const file of parseDiffAdditions(diff)) {
    if (!file.lines.length) continue;
    const block = "文件: " + file.path + "\n" +
      file.lines.map(line => "  " + line).join("\n");
    if (used + block.length > limit) {
      const room = limit - used;
      if (room > 80) blocks.push(block.slice(0, room) + "\n…");
      truncated = true;
      break;
    }
    blocks.push(block);
    used += block.length + 1;
  }
  return { text: blocks.join("\n\n"), truncated };
}

function writeSensitive(files) {
  const out = process.env.SENSITIVE_OUT;
  if (!out || !files.length) return;
  try { fs.writeFileSync(out, files.join("\n") + "\n", "utf8"); } catch {}
}

// Merge the deterministic hits with whatever the screening call reported
// (modelResult is null when that call was disabled, unavailable or failed),
// record the outcome for the diagnostic record, and publish the final list.
// screenInfo describes that call; the message call's status is separate.
function recordSensitive(modelResult, screenInfo) {
  const model = modelResult && Array.isArray(modelResult.files) ? modelResult.files : [];
  const merged = [];
  const seen = new Set();
  for (const file of [...localSensitive, ...model]) {
    const key = pathKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }
  const capped = merged.slice(0, MAX_SENSITIVE);
  scanState = {
    screened: modelResult ? "model+local" : "local",
    local: localSensitive.length,
    model: model.length,
    unmatched: modelResult && Array.isArray(modelResult.unmatched)
      ? modelResult.unmatched.length : 0,
    truncated: merged.length > MAX_SENSITIVE,
    excluded: capped.length,
    screen: screenInfo || { status: "pending" }
  };
  writeSensitive(capped);
  // The message call may have written its status before the screening call
  // finished (the two run concurrently); rewrite it so the final record
  // carries the completed screening summary.
  if (lastAiStatus) writeAiStatus(lastAiStatus);
  return capped;
}

// --- AI diagnostics ---------------------------------------------------------
// AI_STATUS_OUT receives one compact JSON object describing how the commit
// message was produced. auto-commit.sh embeds it as the "ai" field of
// last-run.json and status.cjs prints it. Keep it free of secrets: only
// identities, endpoints (query stripped), timings and error messages go in;
// never API keys, tokens or the model's response text.
let aiStatusWritten = false;
// Last message-status object, kept so a screening result that lands after the
// message finished can re-embed the final scanState into the same record.
let lastAiStatus = null;

// Set by main() before the model calls: deterministic scan hits and the last
// screening outcome. writeAiStatus embeds the summary (counts only - never
// paths or content) so "screened and found nothing" is distinguishable from
// "never screened" in last-run.json.
let localSensitive = [];
let scanState = null;

// Single-line, bounded, secret-scrubbed text for the diagnostic record.
function clip(value, max) {
  const text = String(value == null ? "" : value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-…")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1…")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "…")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

// Endpoints can carry credentials in userinfo or a query string; record only
// origin + path.
function safeUrl(value) {
  const raw = String(value || "");
  try {
    const u = new URL(raw);
    return u.origin + u.pathname;
  } catch {
    return raw.replace(/[?#].*$/, "");
  }
}

function writeAiStatus(obj) {
  aiStatusWritten = true;
  lastAiStatus = obj;
  const out = process.env.AI_STATUS_OUT;
  if (!out) return;
  let json;
  try {
    json = JSON.stringify(scanState ? { ...obj, sensitive: scanState } : obj);
  } catch { return; }
  if (json.length > 4000) {
    json = JSON.stringify({
      status: obj.status,
      reason: "diagnostic record omitted (too large)",
      sensitive: scanState || undefined
    });
  }
  try { fs.writeFileSync(out, json + "\n", "utf8"); } catch {}
}

function addNote(notes, source, reason) {
  if (Array.isArray(notes)) notes.push({ source, reason: clip(reason, 200) });
}

function describeFetchError(err, timeoutMs) {
  const cause = err && err.cause;
  const text = String((err && (err.message || err.name)) ||
    (cause && cause.message) || "request failed");
  const aborted = (err && err.name === "AbortError") ||
    /\babort(?:ed)?\b/i.test(text) ||
    !!(cause && /\babort(?:ed)?\b/i.test(String(cause.message || "")));
  if (aborted) return "timeout after " + timeoutMs + " ms";
  let msg = text;
  if (cause) {
    const bits = [];
    if (cause.code) bits.push(String(cause.code));
    if (cause.message && cause.message !== msg) bits.push(String(cause.message));
    if (bits.length) msg += " (" + bits.join(": ") + ")";
  }
  return clip(msg, 200);
}

async function httpErrorDetail(res) {
  let detail = "";
  try {
    const body = (await res.text()).trim();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        const err = parsed && (parsed.error || parsed);
        detail = (err && typeof err === "object" && (err.message || err.type)) ||
          (typeof err === "string" ? err : "") || body;
      } catch {
        detail = body;
      }
    }
  } catch {}
  detail = clip(detail, 200);
  return "HTTP " + res.status + (res.statusText ? " " + res.statusText : "") +
    (detail ? ": " + detail : "");
}

function pushAttempt(attempts, attempt) {
  if (attempts.length < 12) attempts.push(attempt);
}

function loadZcodeProvider(notes, opts) {
  const disabled = noAiReason(opts && opts.settings);
  if (disabled) {
    addNote(notes, "zcode", disabled);
    return null;
  }
  // The session's own provider config: ZCode injects its path into the hook
  // environment, so the hook follows whatever provider the session runs on.
  const file = process.env.AUTOCOMMIT_PROVIDER_CONFIG ||
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
    path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
    addNote(notes, "zcode", "provider config not readable: " + file);
    return null;
  }
  const rules = cfg && cfg.config && cfg.config.providerConfigRules && cfg.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) {
    addNote(notes, "zcode", "provider config has no providerRules: " + file);
    return null;
  }
  const apiOf = r => (r && r.config && r.config.api) || {};
  const usable = r => r && apiOf(r).baseUrl &&
    (process.env.AUTOCOMMIT_LLM_KEY || (r.config.access && r.config.access.apiKey));
  const isAnthropic = r => /anthropic-messages/i.test(String(apiOf(r).type || ""));
  // providerId is user-set and unstable, so it never takes part in selection:
  // the first usable rule in file order wins, the rule's api.type decides
  // request style and auth, and models are tried in its modelOrder order.
  const rule = rules.find(usable);
  if (!rule) {
    addNote(notes, "zcode", "no rule with baseUrl and access.apiKey in " + file);
    return null;
  }
  const api = apiOf(rule);
  const key = process.env.AUTOCOMMIT_LLM_KEY || (rule.config.access && rule.config.access.apiKey);
  if (!key || !api.baseUrl) {
    addNote(notes, "zcode", "selected provider rule has no baseUrl or API key");
    return null;
  }

  const override = process.env.AUTOCOMMIT_LLM_URL;
  let url;
  if (override) {
    url = isAnthropic(rule)
      ? (/\/messages$/.test(override) ? override : override.replace(/\/+$/, "") + "/v1/messages")
      : (/\/chat\/completions$/i.test(override) ? override : override.replace(/\/+$/, "") + "/v1/chat/completions");
  } else if (isAnthropic(rule)) {
    const base = String(api.baseUrl).replace(/\/+$/, "");
    url = /\/messages$/.test(base) ? base : base + "/v1/messages";
  } else {
    const base = String(api.baseUrl).replace(/\/+$/, "");
    url = /\/v1$/i.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
  }
  const anthropic = !override && isAnthropic(rule);
  const model = process.env.AUTOCOMMIT_LLM_MODEL;
  let models;
  if (model) {
    models = model.split(",").map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(rule.config.modelOrder) && rule.config.modelOrder.length) {
    models = rule.config.modelOrder.filter(m => typeof m === "string" && m);
  } else {
    models = [anthropic ? "glm-5.3-flash" : "workbuddy/deepseek-v4.1-flash"];
  }
  return { url, key, models, kind: anthropic ? "zcode-anthropic" : undefined };
}

// WorkBuddy: the desktop app runs a loopback chat proxy and injects its URL, a
// per-session bearer token and a session context header into the hook env.
// There is no config file and no user API key, so this works out of the box.
// The proxy only speaks SSE (non-stream requests are rejected with 11101) and
// it accepts any model id the account can use.
function loadWorkbuddyProvider(notes) {
  const url = process.env.WORKBUDDY_VLM_CHAT_URL;
  const token = process.env.WORKBUDDY_VLM_AUTH_TOKEN;
  const context = process.env.WORKBUDDY_VLM_CONTEXT;
  if (!url || !token || !context) {
    const missing = [
      ["WORKBUDDY_VLM_CHAT_URL", url],
      ["WORKBUDDY_VLM_AUTH_TOKEN", token],
      ["WORKBUDDY_VLM_CONTEXT", context]
    ].filter(([, value]) => !value).map(([name]) => name);
    addNote(notes, "workbuddy", missing.join(", ") + " not set");
    return null;
  }

  const override = process.env.AUTOCOMMIT_LLM_MODEL;
  const candidates = override
    ? override.split(",")
    : [process.env.CODEBUDDY_CURRENT_MODEL_ID, process.env.WORKBUDDY_VLM_MODEL];
  const seen = new Set();
  const models = candidates
    .map(m => (typeof m === "string" ? m.trim() : ""))
    .filter(m => m && !seen.has(m) && seen.add(m));
  if (!models.length) {
    addNote(notes, "workbuddy",
      "no model id (AUTOCOMMIT_LLM_MODEL / CODEBUDDY_CURRENT_MODEL_ID / WORKBUDDY_VLM_MODEL)");
    return null;
  }
  return { kind: "workbuddy", url, token, context, models };
}

// Claude Code model ids for the helper call, in preference order. A real
// Claude Code 2.1.x hook environment (captured with a Stop probe) does not set
// ANTHROPIC_MODEL at all: it exposes the session's model aliases through
// ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL and ANTHROPIC_SMALL_FAST_MODEL,
// plus the ids in CLAUDE_CODE_MODEL_CAPABILITIES ("id=cap,cap;id=..."). Try
// the explicit pin first, then the small/fast model the harness uses for
// background work, then the alias mappings, then the capability list.
function claudeModelCandidates(override) {
  if (override) return override.split(",").map(s => s.trim()).filter(Boolean);
  const capabilityModels = String(process.env.CLAUDE_CODE_MODEL_CAPABILITIES || "")
    .split(";")
    .map(part => part.split("=")[0].trim())
    .filter(Boolean);
  const seen = new Set();
  return [
    process.env.ANTHROPIC_MODEL,
    process.env.ANTHROPIC_SMALL_FAST_MODEL,
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ...capabilityModels
  ]
    .map(m => (typeof m === "string" ? m.trim() : ""))
    .filter(m => m && !seen.has(m) && seen.add(m));
}

// Windows node cannot stat Git-Bash style /c/... paths; translate them before
// touching the filesystem (the transcript reader does the same for its path).
function nativePath(file) {
  let out = String(file || "");
  if (process.platform === "win32") {
    const m = /^\/([a-z])\/(.*)$/i.exec(out);
    if (m) out = m[1].toUpperCase() + ":/" + m[2];
  }
  return out;
}

// Where to look for the `claude` executable, in order: an explicit env
// override, config.json claudeBin, the host-provided exec path, PATH, then the
// usual install locations. Nothing here runs a subprocess; a missing candidate
// is just skipped.
function claudeCandidates(settings) {
  const win = process.platform === "win32";
  const out = [];
  const add = p => { const v = nativePath(p); if (v) out.push(v); };
  add(process.env.AUTOCOMMIT_CLAUDE_BIN);
  if (settings) add(settings.claudeBin);
  add(process.env.CLAUDE_CODE_EXECPATH);
  const names = win ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  for (const dir of String(process.env.PATH || "").split(win ? ";" : ":")) {
    if (!dir) continue;
    const base = nativePath(dir);
    for (const name of names) add(path.join(base, name));
  }
  const home = os.homedir();
  if (win) {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    add(path.join(home, ".local", "bin", "claude.exe"));
    add(path.join(local, "Programs", "claude", "claude.exe"));
    add(path.join(roaming, "npm", "claude.cmd"));
  } else {
    add(path.join(home, ".local", "bin", "claude"));
    add("/usr/local/bin/claude");
    add("/opt/homebrew/bin/claude");
  }
  return out;
}

function findClaudeCli(settings) {
  const seen = new Set();
  for (const file of claudeCandidates(settings)) {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (!file || seen.has(key)) continue;
    seen.add(key);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (process.platform !== "win32" && !(stat.mode & 0o111)) continue;
    const ext = path.extname(file).toLowerCase();
    return {
      file,
      // .cmd/.bat shims need cmd.exe; .exe (and POSIX scripts) spawn directly.
      viaCmdShell: process.platform === "win32" && (ext === ".cmd" || ext === ".bat")
    };
  }
  return null;
}

// The fallback always asks the CLI for haiku: a commit message is short and
// structured, and the alias maps to whatever small model the account offers.
// This is deliberately not configurable. The session's ANTHROPIC_* model ids
// are ignored too: they are often proxy-specific names a first-party endpoint
// does not know.
const CLI_MODEL = "haiku";

function loadClaudeCliProvider(notes, settings) {
  const disabled = noAiReason(settings);
  if (disabled) {
    addNote(notes, "claude-cli", disabled);
    return null;
  }
  if (process.env.AUTOCOMMIT_IN_HOOK === "1") {
    addNote(notes, "claude-cli", "recursion guard AUTOCOMMIT_IN_HOOK=1");
    return null;
  }
  const cli = findClaudeCli(settings);
  if (!cli) {
    addNote(notes, "claude-cli",
      "claude executable not found (AUTOCOMMIT_CLAUDE_BIN / config.json claudeBin / " +
      "CLAUDE_CODE_EXECPATH / PATH)");
    return null;
  }
  return { kind: "claude-cli", cli, models: [CLI_MODEL] };
}

// Claude Code: no provider config file and no loopback proxy. The session's
// Anthropic endpoint arrives through the standard ANTHROPIC_* environment
// (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY); the
// request style is the same /v1/messages call the zcode-anthropic path uses.
// An explicit AUTOCOMMIT_LLM_URL/_KEY override follows the config.json
// contract instead (URL used verbatim, request style from its shape).
// With no endpoint at all, the caller may allow the claude -p fallback, which
// reuses the CLI's own login; a base URL without a key is a misconfiguration,
// not a subscription login, so the CLI is not allowed to bypass it.
function loadClaudeProvider(notes, opts) {
  const key = process.env.AUTOCOMMIT_LLM_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  const base = process.env.AUTOCOMMIT_LLM_URL || process.env.ANTHROPIC_BASE_URL;
  if (!key || !base) {
    if (opts && opts.allowCli && !base) {
      const cli = loadClaudeCliProvider(notes, opts.settings);
      if (cli) return cli;
    }
    const missing = [];
    if (!base) missing.push("ANTHROPIC_BASE_URL/AUTOCOMMIT_LLM_URL");
    if (!key) missing.push("ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY");
    addNote(notes, "claude", missing.join(" and ") + " not set");
    return null;
  }
  let url;
  let kind;
  if (process.env.AUTOCOMMIT_LLM_URL) {
    url = base;
    kind = /\/messages(\/?)$/i.test(url) ? "zcode-anthropic" : undefined;
  } else {
    url = String(base).replace(/\/+$/, "");
    url = /\/messages$/.test(url) ? url : url + "/v1/messages";
    kind = "zcode-anthropic";
  }
  const candidates = claudeModelCandidates(process.env.AUTOCOMMIT_LLM_MODEL);
  if (!candidates.length) {
    addNote(notes, "claude",
      "no model candidate from ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL / ANTHROPIC_DEFAULT_*_MODEL / CLAUDE_CODE_MODEL_CAPABILITIES");
    return null;
  }
  return { url, key, models: candidates, kind };
}

// Manual endpoint from config.json (written by scripts/config.cjs). An
// explicit user choice, so a complete url+key+model trio outranks the
// session-derived providers; AUTOCOMMIT_LLM_* env overrides win per key and
// are already folded into settings.manual. Request style follows the URL
// shape: .../v1/messages -> anthropic. A settings-only file (no endpoint) is
// silent; a partial endpoint records one diagnostic and falls back.
function loadManualProvider(notes, settings) {
  const resolved = settings || runtimeSettings();
  if (resolved.manual) {
    return { ...resolved.manual, source: "manual" };
  }
  for (const problem of resolved.problems) addNote(notes, "manual", problem);
  if (resolved.manualIncomplete) {
    addNote(notes, "manual",
      "config.json has an incomplete manual endpoint (need url, key and model): " +
      resolved.file);
  }
  return null;
}

// Commit-message model sources per agent — the runtime mirror of the
// install-side registry in scripts/lib.cjs. The hook script reports CodeBuddy
// as "codebuddy:<host>"; aliases match on the prefix before the colon. An
// unknown agent tries the sources in UNKNOWN_SOURCE_ORDER until one is
// actually available. Payload extraction above is deliberately field-driven
// rather than agent-driven; only the model source dispatches on identity.
const MODEL_SOURCES = {
  zcode: loadZcodeProvider,
  workbuddy: loadWorkbuddyProvider,
  claude: loadClaudeProvider
};
const MODEL_SOURCE_ALIASES = { codebuddy: "workbuddy" };
const UNKNOWN_SOURCE_ORDER = ["claude", "workbuddy", "zcode"];

// Resolution order for the message model: the complete manual endpoint in
// config.json first, then the session-derived source for the detected agent
// (WorkBuddy's loopback proxy from the hook environment, ZCode's provider
// config from disk, Claude Code's ANTHROPIC_* environment). AUTOCOMMIT_LLM_*
// env overrides win over everything and are folded into settings.manual.
function loadProvider(notes, settings) {
  settings = settings || runtimeSettings();
  const manual = loadManualProvider(notes, settings);
  if (manual) return manual;
  const agent = String(process.env.AUTOCOMMIT_AGENT || "").toLowerCase();
  const base = agent.split(":")[0];
  const key = MODEL_SOURCES[agent] ? agent : MODEL_SOURCE_ALIASES[base];
  if (key && MODEL_SOURCES[key]) {
    const provider = MODEL_SOURCES[key](notes,
      { allowCli: key === "claude", settings });
    return provider ? { ...provider, source: key } : null;
  }
  // Unknown host or manual run: use whichever source is actually available.
  for (const name of UNKNOWN_SOURCE_ORDER) {
    const provider = MODEL_SOURCES[name](notes, { settings });
    if (provider) return { ...provider, source: name };
  }
  // Last resort for an unknown host: the local CLI, which may still be logged
  // in even when no session provider environment is visible.
  const cli = loadClaudeCliProvider(notes, settings);
  return cli ? { ...cli, source: "claude" } : null;
}

// --- claude -p fallback -----------------------------------------------------
// The hook never reads ~/.claude/.credentials.json or the macOS Keychain: the
// CLI owns authentication. Bare mode is not an option here because it
// explicitly refuses OAuth; hooks are switched off through an added settings
// layer, and AUTOCOMMIT_IN_HOOK plus the git lock stop a nested Stop even if
// that layer is overridden by managed settings.
function cliEnv() {
  const env = { ...process.env };
  for (const name of CLI_ENV_DROP) delete env[name];
  for (const name of Object.keys(env)) {
    // The hook's own knobs (including AUTOCOMMIT_LLM_KEY) mean nothing to the
    // CLI and must not leak into a child that may run tools.
    if (/^AUTOCOMMIT_/i.test(name)) delete env[name];
  }
  env.AUTOCOMMIT_IN_HOOK = "1";
  return env;
}

function killCliTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      const taskkill = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "taskkill.exe");
      // /T kills the whole tree. Do not kill the wrapper ourselves first: with
      // a .cmd shim the wrapper is cmd.exe, and destroying it before taskkill
      // runs would orphan the real CLI.
      const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => { try { child.kill(); } catch {} });
      if (killer.unref) killer.unref();
    } catch {
      try { child.kill(); } catch {}
    }
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    try { child.kill(); } catch {}
  }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }, 1500);
  if (timer.unref) timer.unref();
}

// Flags by compatibility tier: newer options first, then a plain `-p` run.
// The prompt itself always travels on stdin so it never hits the Windows
// command-line limit and never appears in a process list.
function cliArgs(tier, model, settingsPath) {
  const args = ["-p"];
  if (tier <= 2) {
    args.push("--output-format", "json");
    if (settingsPath) args.push("--settings", settingsPath);
  }
  if (tier === 1) {
    args.push("--strict-mcp-config", "--tools", "", "--no-session-persistence");
  }
  if (model) args.push("--model", model);
  return args;
}

// CommandLineToArgvW-compatible quoting for the cmd.exe path. `shell: true`
// would concatenate the arguments unescaped (deprecated by node), and the
// settings path can contain spaces; an empty argument (--tools "") must survive
// as an empty argument too.
function winQuote(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(s)) return s;
  const quoted = s.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1");
  return '"' + quoted + '"';
}

function spawnCli(cli, args, spawnOpts) {
  if (!cli.viaCmdShell) return spawn(cli.file, args, spawnOpts);
  const inner = [winQuote(cli.file), ...args.map(winQuote)].join(" ");
  // /s strips the outer pair so an executable path with spaces stays quoted.
  return spawn(process.env.ComSpec || "cmd.exe",
    ["/d", "/s", "/c", '"' + inner + '"'],
    { ...spawnOpts, windowsVerbatimArguments: true });
}

function runClaudeCli(cli, input, opts) {
  return new Promise(resolve => {
    const timeoutMs = Math.max(1000, Number(opts && opts.timeoutMs) || CLI_ATTEMPT_DEFAULT);
    const args = cliArgs(opts && opts.tier, opts && opts.model, opts && opts.settingsPath);
    const spawnOpts = {
      // A neutral cwd keeps the child away from the project's CLAUDE.md and
      // file tools; it has no business reading the repository.
      cwd: os.tmpdir(),
      env: cliEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    };
    let child;
    try {
      child = spawnCli(cli, args, spawnOpts);
    } catch (error) {
      resolve({ code: null, error, stdout: "", stderr: "", timedOut: false, overflow: false });
      return;
    }
    const outDecoder = new TextDecoder("utf-8");
    const errDecoder = new TextDecoder("utf-8");
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let overflow = false;
    let finished = false;
    let timer = null;
    let watchdog = null;
    const done = result => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      // Release the pipes as well: a grandchild (cmd.exe -> node) killed on
      // timeout can outlive the wrapper and otherwise keep this process alive
      // through the inherited stdio handles.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        try { if (stream) stream.destroy(); } catch {}
      }
      try { child.unref(); } catch {}
      resolve(result);
    };
    const stop = () => { try { killCliTree(child); } catch {} };
    timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    // A shell wrapper can outlive its child or lose the close event; resolve
    // anyway so the helper never hangs past its budget.
    watchdog = setTimeout(() => {
      stop();
      done({ code: null, stdout, stderr, timedOut, overflow, watchdog: true });
    }, timeoutMs + 3000);
    if (timer.unref) timer.unref();
    if (watchdog.unref) watchdog.unref();
    child.stdout.on("data", buf => {
      if (finished) return;
      outBytes += buf.length;
      if (outBytes > CLI_STDOUT_CAP) {
        overflow = true;
        stop();
        return;
      }
      stdout += outDecoder.decode(buf, { stream: true });
    });
    child.stderr.on("data", buf => {
      if (finished || errBytes > CLI_STDERR_CAP) return;
      errBytes += buf.length;
      stderr += errDecoder.decode(buf, { stream: true });
      if (stderr.length > CLI_STDERR_CAP) stderr = Array.from(stderr).slice(0, CLI_STDERR_CAP).join("");
    });
    child.on("error", error => {
      stop();
      done({ code: null, error, stdout, stderr, timedOut, overflow });
    });
    child.on("close", (code, signal) => {
      done({ code, signal, stdout, stderr, timedOut, overflow });
    });
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(String(input || ""), "utf8");
    } catch {}
  });
}

function parseCliEnvelope(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  // Diagnostics (for example an unrecognized-model warning) can share stdout
  // with the envelope. Scan backwards for a line that is the result object.
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && (obj.type === "result" || obj.result !== undefined || obj.is_error !== undefined)) {
        return obj;
      }
    } catch {}
  }
  // Pretty-printed JSON with surrounding noise.
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

function cliFailure(res, timeoutMs) {
  if (res.timedOut) return "timeout after " + timeoutMs + " ms";
  if (res.overflow) return "output exceeded 1 MB";
  if (res.error) {
    return clip((res.error && (res.error.message || res.error.code)) || res.error, 200);
  }
  const bits = [];
  if (typeof res.code === "number") bits.push("exit " + res.code);
  const detail = clip(res.stderr, 200);
  if (detail) bits.push(detail);
  return bits.join(": ") || "claude -p failed";
}

function cliEnvelopeError(env, res) {
  const bits = [];
  if (typeof env.subtype === "string") bits.push(env.subtype);
  if (Array.isArray(env.errors)) {
    for (const item of env.errors) {
      if (item && typeof item === "object") bits.push(item.message || item.error || item.type);
      else if (item) bits.push(item);
    }
  }
  if (!bits.length && typeof env.error === "string") bits.push(env.error);
  if (!bits.length) bits.push(res.stderr);
  return clip(bits.filter(Boolean).join(": ") || "claude -p reported an error", 200);
}

// Only a CLI that does not recognize a flag is retried with a simpler argument
// set; an auth failure or timeout would just burn the remaining budget.
function cliFlagRejected(res) {
  return !res.timedOut && !res.overflow && !res.error &&
    /(unknown (option|flag|argument)|invalid option|unrecognized (option|argument)|unexpected argument)/i
      .test(String(res.stderr || ""));
}

// A bounded file list for prompts; the whitelist that validates the model's
// answer always covers every staged path, not just the listed ones.
function promptFileList(limit) {
  const files = changedFiles();
  const listed = files.slice(0, limit);
  const lines = listed.slice();
  if (files.length > listed.length) {
    lines.push("…另有 " + (files.length - listed.length) + " 个文件未列出");
  }
  return lines;
}

// Message prompt: only the agent's final reply and the staged file names. The
// diff is deliberately absent - it exists for screening, which has its own
// call. Keeping the two apart keeps this prompt small and lets a screening
// failure leave the message untouched.
function buildMessagePrompt(text) {
  const clipped = Array.from(text).slice(0, 12000).join("");
  const files = promptFileList(200);
  const prompt = [
    "根据下面的 AGENT_FINAL_MESSAGE（agent 本轮最终回复）生成一条 git 提交信息。要求：",
    "1. type 只能是：" + TYPES.join(", ") + "。",
    "2. subject：使用与 AGENT_FINAL_MESSAGE 相同的主语言概括本轮改动，不超过 40 个字符，不加句号，不要以 type 开头。",
    "3. body：2-5 条要点，每条一句话，概括本轮实际改动和结果；不要复述执行过程；不要输出文件数量、增删行数等 diffstat；不要编造消息中没有的信息。",
    '4. 只输出一个 JSON 对象，不要 markdown 代码块：{"type":"fix","subject":"...","body":["..."]}'
  ];
  if (files.length) prompt.push("", "CHANGED_FILES（本轮暂存的文件路径）:", files.join("\n"));
  prompt.push("", "AGENT_FINAL_MESSAGE:", "<<<", clipped, ">>>");
  return {
    // The role line rides in the user message, not --system-prompt: replacing
    // Claude Code's default system prompt can break subscription OAuth.
    systemText: "你是 git 提交信息生成器，只输出 JSON 对象。",
    userText: prompt.join("\n")
  };
}

// Screening prompt: staged paths plus a compact added-lines view, with a
// recall-biased policy. A false positive costs one file in a checkpoint; a
// false negative leaks a secret. The whitelist bounds what a wrong answer can
// unstage, so "when in doubt, flag it" is safe.
function buildScreenPrompt() {
  const files = promptFileList(200);
  const view = addedLinesView(readDiff());
  const prompt = [
    "检查下面的 FILE_LIST 和 ADDED_LINES（本轮暂存文件的新增行），找出含敏感信息的文件：",
    "API key、access token、私钥/证书、密码或口令、数据库/消息队列连接串、云服务凭据等。",
    "规则：",
    "- 路径必须逐字来自 FILE_LIST，最多 10 个。",
    "- 有疑问就标记：漏报的代价高于误报；无法确定时也放进结果。",
    "- 新增行为空时也可以仅凭文件名判断（例如 .env、id_rsa、credentials.json）。",
    "- 只输出一个 JSON 对象，不要 markdown 代码块：{\"sensitiveFiles\":[]}",
    ""
  ];
  prompt.push("FILE_LIST:", files.length ? files.join("\n") : "(empty)");
  prompt.push("", "ADDED_LINES（仅新增行，可能截断）:", "<<<", view.text || "(none)", ">>>");
  if (view.truncated) prompt.push("（新增行视图已截断，靠后的文件未显示）");
  return {
    systemText: "你是敏感信息筛查器，只输出 JSON 对象。",
    userText: prompt.join("\n")
  };
}

// Run one `claude -p` prompt through the model/tier ladder until accept()
// returns a value. Never writes status or sensitive output: the caller owns
// both, so the message and screening calls stay independent.
async function runCliModels(provider, promptText, opts, accept) {
  const deadline = opts.deadline;
  const attempts = [];
  let budgetStopped = false;
  let settingsDir = "";
  try {
    settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-commit-cli-"));
    fs.writeFileSync(path.join(settingsDir, "settings.json"),
      JSON.stringify(CLI_SETTINGS), "utf8");
  } catch {
    // Without the settings layer the recursion sentinel and git lock still
    // hold; record nothing secret and carry on.
    settingsDir = "";
  }
  const settingsPath = settingsDir ? path.join(settingsDir, "settings.json") : "";
  try {
    for (const model of provider.models) {
      const budget = deadline - Date.now();
      if (budget < 1000) { budgetStopped = true; break; }
      const attempt = { model };
      const attemptStart = Date.now();
      for (const tier of [1, 2, 3]) {
        const left = deadline - Date.now();
        if (left < 1000) { budgetStopped = true; break; }
        if (tier > 1 && left < CLI_MIN_RETRY_MS) break;
        const timeoutMs = Math.min(opts.perAttemptMs, left);
        const res = await runClaudeCli(provider.cli, promptText,
          { model, settingsPath, tier, timeoutMs });
        let retryTier = false;
        if (typeof res.code === "number") attempt.code = res.code;
        if (res.timedOut) {
          attempt.error = "timeout after " + timeoutMs + " ms";
        } else if (res.overflow) {
          attempt.error = "output exceeded 1 MB";
        } else if (res.error) {
          attempt.error = cliFailure(res, timeoutMs);
        } else {
          const envelope = parseCliEnvelope(res.stdout);
          const failed = envelope && typeof envelope === "object" &&
            (envelope.is_error === true ||
              (typeof envelope.subtype === "string" && envelope.subtype !== "success"));
          if (failed) {
            attempt.error = cliEnvelopeError(envelope, res);
          } else if (typeof res.code === "number" && res.code !== 0) {
            attempt.error = cliFailure(res, timeoutMs);
          } else {
            let raw = null;
            const result = envelope && envelope.result;
            if (result && typeof result === "object") {
              raw = result;
            } else {
              const content = typeof result === "string" ? result : res.stdout;
              raw = parseModelJson(content);
            }
            const value = accept(raw);
            if (value) {
              delete attempt.error;
              delete attempt.code;
              attempt.ms = Date.now() - attemptStart;
              pushAttempt(attempts, attempt);
              return { value, model, attempts };
            }
            attempt.error = opts.unusable;
          }
        }
        retryTier = cliFlagRejected(res);
        if (!retryTier) break;
      }
      attempt.ms = Date.now() - attemptStart;
      pushAttempt(attempts, attempt);
    }
  } finally {
    if (settingsDir) {
      try { fs.rmSync(settingsDir, { recursive: true, force: true }); } catch {}
    }
  }
  return { value: null, model: "", attempts, budgetStopped };
}

// One HTTP call, never throwing: a failure comes back as { error } so the
// caller can record it per attempt.
async function httpCall(provider, model, prompt, opts, signal) {
  const streaming = provider.kind === "workbuddy";
  const anthropic = provider.kind === "zcode-anthropic";
  const messages = [
    { role: "system", content: prompt.systemText },
    { role: "user", content: prompt.userText }
  ];
  const headers = { "Content-Type": "application/json" };
  if (streaming) {
    headers["Authorization"] = "Bearer " + provider.token;
    // The proxy resolves its session from this header; a plain Bearer
    // token alone is answered with 401 unauthorized.
    headers["x-workbuddy-mcp-context"] = provider.context;
  } else if (anthropic) {
    // Anthropic Messages API; Bearer is sent alongside x-api-key because
    // local proxies differ in which one they check.
    headers["x-api-key"] = provider.key;
    headers["Authorization"] = "Bearer " + provider.key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = "Bearer " + provider.key;
  }
  // Anthropic endpoints: disable thinking explicitly. It is a no-op for the
  // official API (thinking is opt-in there) and switches off the default-on
  // thinking of GLM/Kimi/DeepSeek-style compatible endpoints, which otherwise
  // burn the time budget before the JSON comes back. The OpenAI-style body has
  // no cross-vendor equivalent (OpenAI rejects the field), so its endpoints
  // keep their default.
  const body = anthropic
    ? {
        model: model,
        max_tokens: opts.maxTokens,
        temperature: 0.2,
        thinking: { type: "disabled" },
        system: messages[0].content,
        messages: [{ role: "user", content: messages[1].content }]
      }
    : {
        model: model,
        messages,
        temperature: 0.2,
        max_tokens: opts.maxTokens,
        stream: streaming
      };
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) return { error: await httpErrorDetail(res) };
    const content = streaming
      ? await readSseText(res)
      : anthropic
        ? ((data => Array.isArray(data && data.content)
            ? data.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("")
            : "")(await res.json()))
        : ((data => data && data.choices && data.choices[0] &&
            data.choices[0].message && data.choices[0].message.content)(await res.json()));
    if (typeof content !== "string" || !content.trim()) return { error: "empty response" };
    return { content };
  } catch (err) {
    return { error: describeFetchError(err, opts.timeoutMs) };
  }
}

// Try each model in order until accept() returns a value. Models are tried
// sequentially, as before, but the message and screening calls run as two
// independent instances of this loop.
async function runHttpModels(provider, prompt, opts, accept) {
  const attempts = [];
  const tried = new Set();
  let budgetStopped = false;
  for (const model of provider.models) {
    if (!model || tried.has(model)) continue;
    tried.add(model);
    const budget = opts.deadline - Date.now();
    if (budget < 1000) { budgetStopped = true; break; }
    const attempt = { model };
    const attemptStart = Date.now();
    const timeoutMs = Math.min(opts.perAttemptMs, budget);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await httpCall(provider, model, prompt,
        { maxTokens: opts.maxTokens, timeoutMs }, controller.signal);
      if (res.error) {
        attempt.error = res.error;
      } else {
        const value = accept(parseModelJson(res.content));
        if (value) {
          attempt.ms = Date.now() - attemptStart;
          pushAttempt(attempts, attempt);
          return { value, model, attempts };
        }
        attempt.error = opts.unusable;
      }
    } finally {
      clearTimeout(timer);
    }
    attempt.ms = Date.now() - attemptStart;
    pushAttempt(attempts, attempt);
  }
  return { value: null, model: "", attempts, budgetStopped };
}

// Concatenate delta.content out of an SSE response. The proxy interleaves
// heartbeat comments and usage-only chunks; reasoning models put their thinking
// in delta.reasoning_content, which is deliberately ignored.
async function readSseText(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const choice = chunk && chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === "string") out += delta.content;
      const msg = choice && choice.message;
      if (msg && typeof msg.content === "string" && !delta) out += msg.content;
    }
  }
  return out;
}

function parseModelJson(content) {
  let s = String(content).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function validate(obj, fallback) {
  if (!obj || typeof obj !== "object") return null;

  let type = String(obj.type || "").toLowerCase().trim();
  let subject = cleanLine(String(obj.subject || ""));
  subject = subject.replace(new RegExp("^(?:" + TYPES.join("|") + ")(?:\\([^)]*\\))?\\s*[:：]\\s*", "i"), "");
  const chars = Array.from(subject);
  if (chars.length > 60) subject = chars.slice(0, 60).join("") + "…";
  if (!subject) return null;
  if (!TYPES.includes(type)) type = inferTypeFromText(subject) || fallback.type;

  const seen = new Set();
  const body = (Array.isArray(obj.body) ? obj.body : [])
    .map(x => cleanLine(String(x)))
    .filter(x => x && !/files? changed|insertions?\(|deletions?\(|\bdiffstat\b/i.test(x))
    .filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 5);

  return { type, subject, body };
}

// Per-task model budget: env > config.json > transport default. Each task
// gets the full budget; because the two tasks run concurrently, wall-clock
// stays near one task's budget rather than their sum.
function modelBudget(isCli, started, maxTokens, unusable, settings) {
  const perAttemptMs = (settings && settings.aiTimeoutMs) ||
    (isCli ? CLI_ATTEMPT_DEFAULT : 8000);
  const totalMs = (settings && settings.aiTotalMs) ||
    (isCli ? CLI_TOTAL_DEFAULT : 13000);
  return {
    perAttemptMs, totalMs, started, maxTokens, unusable,
    deadline: started + totalMs
  };
}

function modelFailureReason(run) {
  return run.budgetStopped
    ? "total time budget exhausted (AUTOCOMMIT_AI_TOTAL_MS)"
    : run.attempts.length ? "every model attempt failed" : "no model configured";
}

function runPrompt(provider, prompt, opts, accept) {
  if (provider.kind === "claude-cli") {
    return runCliModels(provider,
      prompt.systemText + "\n\n" + prompt.userText, opts, accept);
  }
  return runHttpModels(provider, prompt, opts, accept);
}

// Message task: the agent's final reply is its only substantive input. A
// missing or unusable answer prints nothing; the shell hook then writes the
// file-list placeholder from the index that both exclusion layers left behind.
async function aiDraft(text, settings) {
  const disabled = noAiReason(settings);
  if (disabled) {
    writeAiStatus({ status: "disabled", reason: disabled });
    return null;
  }
  if (!text.trim()) {
    writeAiStatus({ status: "skipped", reason: "empty agent final message" });
    return null;
  }
  const notes = [];
  const provider = loadProvider(notes, settings);
  if (!provider) {
    writeAiStatus({
      status: "unavailable",
      reason: "no model provider configured",
      agent: String(process.env.AUTOCOMMIT_AGENT || "unknown"),
      checked: notes
    });
    return null;
  }

  const isCli = provider.kind === "claude-cli";
  const started = Date.now();
  const opts = modelBudget(isCli, started, 600,
    "response was not usable commit JSON", settings);
  const run = await runPrompt(provider, buildMessagePrompt(text), opts,
    raw => validate(raw, { type: "chore" }));
  const base = {
    source: provider.source,
    transport: isCli ? "cli" : "http",
    ...(isCli ? {} : { url: safeUrl(provider.url) })
  };
  if (run.value) {
    writeAiStatus({
      status: "ok", ...base, model: run.model,
      ms: Date.now() - started, attempts: run.attempts
    });
    return run.value;
  }
  writeAiStatus({
    status: "error", reason: modelFailureReason(run), ...base,
    ms: Date.now() - started, attempts: run.attempts
  });
  return null;
}

// Screening task: an independent model call with only the staged file list and
// added lines, a recall-biased policy, and its own small output budget. It
// records its outcome itself; a failure here leaves the message task and the
// deterministic scan untouched.
async function aiScreen(settings) {
  try {
    const started = Date.now();
    const disabled = noAiReason(settings);
    if (disabled) {
      recordSensitive(null, { status: "disabled", reason: disabled });
      return;
    }
    if (!changedFiles().length) {
      recordSensitive(null, { status: "skipped", reason: "no staged files" });
      return;
    }
    const provider = loadProvider([], settings);
    if (!provider) {
      recordSensitive(null, {
        status: "unavailable",
        reason: "no model provider configured"
      });
      return;
    }
    const isCli = provider.kind === "claude-cli";
    const opts = modelBudget(isCli, started, 200,
      "response was not usable screening JSON", settings);
    const run = await runPrompt(provider, buildScreenPrompt(), opts,
      raw => (raw && Array.isArray(raw.sensitiveFiles) ? collectSensitive(raw) : null));
    const base = { transport: isCli ? "cli" : "http", ms: Date.now() - started };
    if (run.value) {
      recordSensitive(run.value, { status: "ok", model: run.model, ...base });
    } else {
      recordSensitive(null, {
        status: "error",
        reason: modelFailureReason(run),
        attempts: run.attempts,
        ...base
      });
    }
  } catch (err) {
    recordSensitive(null, {
      status: "error",
      reason: "screening crashed: " + clip((err && err.message) || err, 200)
    });
  }
}

function formatMessage(draft) {
  const lines = [draft.type + ": " + draft.subject];
  if (draft.body && draft.body.length) {
    lines.push("");
    for (const item of draft.body) lines.push("- " + item);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const text = readPayload();
  // Resolve env/config once so both model tasks share the same settings and
  // budget instead of reading the file twice concurrently.
  const settings = runtimeSettings();
  // The deterministic content screen runs before, and independently of, the
  // model call: an unavailable, disabled or timed-out model must not turn the
  // screening off. Its result is published even if nothing else succeeds.
  localSensitive = scanSensitiveDiff(readDiff());
  recordSensitive(null, { status: "pending" });
  // Two independent model calls: the message needs only the agent reply, the
  // screen only the staged paths and added lines. Start the screen first so
  // they overlap; neither can make the other fail.
  const screen = aiScreen(settings);
  const draft = await aiDraft(text, settings);
  await screen;
  // No draft means no stdout: the shell builds the fallback subject after both
  // exclusion layers, so the message can never name a file the gate removed.
  if (draft) process.stdout.write(formatMessage(draft));
}

if (require.main === module) {
  // Never fail the hook: any unexpected error falls back to the shell's
  // generic subject. The failure itself still goes into the AI status record
  // so last-run.json can explain why the message is the placeholder.
  main().catch(err => {
    if (!aiStatusWritten) {
      writeAiStatus({
        status: "error",
        reason: "message helper crashed: " + clip((err && err.message) || err, 200)
      });
    }
  });
}

module.exports = {
  parsePayload, cleanLine, validate,
  formatMessage, loadProvider, MODEL_SOURCES, loadManualProvider,
  loadWorkbuddyProvider, loadClaudeProvider, loadClaudeCliProvider,
  claudeModelCandidates, CLI_MODEL, findClaudeCli,
  userConfigFile, readUserConfig, runtimeSettings, noAiReason,
  buildMessagePrompt, buildScreenPrompt, addedLinesView, parseDiffAdditions,
  parseCliEnvelope, runClaudeCli, lastAssistantFromTranscript, readSseText,
  changedFiles, readDiff, collectSensitive, writeSensitive,
  scanSensitiveDiff, matchStaged, normalizeRepoPath, MAX_SENSITIVE
};
