#!/usr/bin/env node
// ZCode auto-commit message generator, called by auto-commit.sh.
//
// stdin : Stop hook JSON payload - only the last_assistant_message field is
//         read; everything else in the payload is ignored.
// env   : CHANGED                     changed file paths, newline separated
//         DIFF_FILE                    file holding the staged diff (HEAD vs
//                                     index, pre-clipped by the shell); its
//                                     presence enables the sensitive-content
//                                     screen described below
//         SENSITIVE_OUT                output file: newline-separated staged
//                                     paths the model flagged as containing
//                                     sensitive content (written only if any;
//                                     auto-commit.sh unstages them)
//         AUTOCOMMIT_AGENT             agent type from auto-commit.sh (zcode |
//                                     workbuddy | codebuddy:* | unknown);
//                                     selects the model source below
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
//         AUTOCOMMIT_NO_AI=1           disable the model call
//         AUTOCOMMIT_PROVIDER_CONFIG   override provider_config.json path
//         AUTOCOMMIT_LLM_URL / _KEY    endpoint overrides
//         AUTOCOMMIT_LLM_MODEL         comma-separated candidate models; default
//                                     is the provider's modelOrder (ZCode) or
//                                     the session model env (WorkBuddy), tried
//                                     in order until one succeeds
//         AUTOCOMMIT_AI_TIMEOUT_MS     per-model timeout (default 8000)
//         AUTOCOMMIT_AI_TOTAL_MS       overall model budget (default 13000)
// stdout: full commit message text (Conventional Commits subject + AI body)
//
// The model summarizes the agent's final reply into a conventional commit
// subject and 2-5 body bullets. Any failure falls back to local heuristics so
// the hook never blocks or fails the turn.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];

function parsePayload(raw) {
  let payload = {};
  try { payload = JSON.parse(String(raw || "{}")) || {}; } catch {}
  return String(payload.last_assistant_message || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function readPayload() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  return parsePayload(raw);
}

function pickLine(text) {
  const noise = l => !/\S/.test(l) ||
    /^\s*(```|~~~|#{1,6}\s*$|>+\s*$|[-*_]{3,}\s*$)/.test(l) ||
    /^\s*\|.*\|\s*$/.test(l);
  const generic = l => /^\s*(?:#{1,6}\s*)?(?:以下(?:是|为)[^\n]*|改动内容|变更内容|修改内容|改动说明|变更说明|完成情况|工作内容|完成总结|总结|摘要|summary|changes?|done|完成|已完成)\s*[:：]?\s*$/i.test(l);
  for (const line of text.split(/\r?\n/)) {
    if (!noise(line) && !generic(line)) return line;
  }
  return "";
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

function changedFiles() {
  return (process.env.CHANGED || "").split(/\r?\n/).filter(Boolean);
}

function readDiff() {
  const file = process.env.DIFF_FILE;
  if (!file) return "";
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// Layer 2 of the sensitive gate: paths the model flagged as containing
// sensitive content. Only paths that are actually staged (present in CHANGED)
// are accepted, so a hallucinated path can never unstage anything.
function collectSensitive(obj) {
  const changed = new Set(changedFiles());
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(obj && obj.sensitiveFiles) ? obj.sensitiveFiles : [])) {
    const f = String(raw).trim();
    if (f && changed.has(f) && !seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out.slice(0, 10);
}

function writeSensitive(files) {
  const out = process.env.SENSITIVE_OUT;
  if (!out || !files.length) return;
  try { fs.writeFileSync(out, files.join("\n") + "\n", "utf8"); } catch {}
}

function inferTypeFromFiles() {
  const files = changedFiles();
  const all = re => files.length > 0 && files.every(p => re.test(p));
  if (all(/(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|txt)$|(^|\/)readme(\.[a-z]+)?$|(^|\/)licen[cs]e/i)) return "docs";
  if (all(/(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[^/]+$|_(test|spec)\.[^/]+$/i)) return "test";
  if (all(/(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)jenkinsfile$|(^|\/)\.circleci\//i)) return "ci";
  if (all(/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|cargo\.toml|cargo\.lock|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|dockerfile|makefile|cmakelists\.txt|build\.gradle|pom\.xml)$/i)) return "build";
  return "";
}

function localDraft(text) {
  let line = pickLine(text);
  let type = "";
  const m = line.match(new RegExp("^\\s*(" + TYPES.join("|") + ")(?:\\([^)]*\\))?!?:\\s*(.*)$", "i"));
  if (m) {
    type = m[1].toLowerCase();
    line = m[2];
  }
  line = cleanLine(line);
  if (!type) type = inferTypeFromText(text) || inferTypeFromFiles() || "chore";
  const chars = Array.from(line);
  if (chars.length > 60) line = chars.slice(0, 60).join("") + "…";
  return { type, subject: line, body: [] };
}

function loadZcodeProvider() {
  if (process.env.AUTOCOMMIT_NO_AI === "1") return null;
  // The session's own provider config: ZCode injects its path into the hook
  // environment, so the hook follows whatever provider the session runs on.
  const file = process.env.AUTOCOMMIT_PROVIDER_CONFIG ||
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
    path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }  const rules = cfg && cfg.config && cfg.config.providerConfigRules && cfg.config.providerConfigRules.providerRules;
  if (!Array.isArray(rules)) return null;
  const apiOf = r => (r && r.config && r.config.api) || {};
  const usable = r => r && apiOf(r).baseUrl &&
    (process.env.AUTOCOMMIT_LLM_KEY || (r.config.access && r.config.access.apiKey));
  const isAnthropic = r => /anthropic-messages/i.test(String(apiOf(r).type || ""));
  // providerId is user-set and unstable, so it never takes part in selection:
  // the first usable rule in file order wins, the rule's api.type decides
  // request style and auth, and models are tried in its modelOrder order.
  const rule = rules.find(usable);
  if (!rule) return null;
  const api = apiOf(rule);
  const key = process.env.AUTOCOMMIT_LLM_KEY || (rule.config.access && rule.config.access.apiKey);
  if (!key || !api.baseUrl) return null;

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
function loadWorkbuddyProvider() {
  const url = process.env.WORKBUDDY_VLM_CHAT_URL;
  const token = process.env.WORKBUDDY_VLM_AUTH_TOKEN;
  const context = process.env.WORKBUDDY_VLM_CONTEXT;
  if (!url || !token || !context) return null;

  const override = process.env.AUTOCOMMIT_LLM_MODEL;
  const candidates = override
    ? override.split(",")
    : [process.env.CODEBUDDY_CURRENT_MODEL_ID, process.env.WORKBUDDY_VLM_MODEL];
  const seen = new Set();
  const models = candidates
    .map(m => (typeof m === "string" ? m.trim() : ""))
    .filter(m => m && !seen.has(m) && seen.add(m));
  if (!models.length) return null;
  return { kind: "workbuddy", url, token, context, models };
}

// Manual endpoint saved by scripts/setup-llm.cjs (llm-config.json). An
// explicit user choice, so it outranks the session-derived providers; the
// AUTOCOMMIT_LLM_* env overrides (test escape hatch) still win on top of it.
// Request style follows the URL shape: .../v1/messages -> anthropic.
function loadManualProvider() {
  const file = process.env.AUTOCOMMIT_LLM_CONFIG ||
    path.join(os.homedir(), ".agents", "skills", "auto-commit-hook", "llm-config.json");
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!cfg || typeof cfg !== "object") return null;
  const url = String(cfg.url || "").trim();
  const key = String(cfg.key || "").trim();
  const models = (Array.isArray(cfg.model) ? cfg.model : String(cfg.model || "").split(","))
    .map(s => String(s).trim()).filter(Boolean);
  if (!url || !key || !models.length) return null;
  const kind = /\/messages(\/?)$/i.test(url) ? "zcode-anthropic" : undefined;
  return { url, key, models, kind };
}

// Resolution order for the message model: the manual config saved by
// scripts/setup-llm.cjs first, then the session-derived source (WorkBuddy's
// loopback proxy from the hook environment, ZCode's provider config from
// disk). AUTOCOMMIT_LLM_* env overrides win over everything.
function loadProvider() {
  const manual = loadManualProvider();
  if (manual) {
    return {
      ...manual,
      url: process.env.AUTOCOMMIT_LLM_URL || manual.url,
      key: process.env.AUTOCOMMIT_LLM_KEY || manual.key,
      models: process.env.AUTOCOMMIT_LLM_MODEL
        ? process.env.AUTOCOMMIT_LLM_MODEL.split(",").map(s => s.trim()).filter(Boolean)
        : manual.models
    };
  }
  const agent = process.env.AUTOCOMMIT_AGENT || "";
  if (/^(workbuddy|codebuddy)/.test(agent)) return loadWorkbuddyProvider();
  if (agent === "zcode") return loadZcodeProvider();
  // Unknown host or manual run: use whichever source is actually available.
  return loadWorkbuddyProvider() || loadZcodeProvider();
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

async function aiDraft(text, fallback) {
  if (process.env.AUTOCOMMIT_NO_AI === "1" || !text.trim()) return null;
  const provider = loadProvider();
  if (!provider) return null;

  const clipped = Array.from(text).slice(0, 12000).join("");
  const diff = readDiff();
  const diffClip = Array.from(diff).slice(0, 12000).join("");
  const files = changedFiles();
  const prompt = [
    "根据下面的 AGENT_FINAL_MESSAGE（agent 本轮最终回复）生成一条 git 提交信息。要求：",
    "1. type 只能是：" + TYPES.join(", ") + "。",
    "2. subject：使用与 AGENT_FINAL_MESSAGE 相同的主语言概括本轮改动，不超过 40 个字符，不加句号，不要以 type 开头。",
    "3. body：2-5 条要点，每条一句话，概括本轮实际改动和结果；不要复述执行过程；不要输出文件数量、增删行数等 diffstat；不要编造消息中没有的信息。",
    '4. 只输出一个 JSON 对象，不要 markdown 代码块：{"type":"fix","subject":"...","body":["..."],"sensitiveFiles":[]}'
  ];
  if (files.length) {
    prompt.push("", "CHANGED_FILES（本轮暂存的文件路径）:", files.join("\n"));
  }
  if (diffClip) {
    prompt.push(
      "",
      "另外，检查 CHANGED_FILES 和 DIFF 中是否包含敏感信息（API key、token、私钥、证书、密码、数据库连接串等）：",
      "- 把含敏感信息的文件路径放进 sensitiveFiles；路径必须逐字来自 CHANGED_FILES，最多 10 个。",
      "- 只在较有把握时标记，宁缺勿滥；没有就返回 []。",
      "",
      "DIFF:",
      "<<<",
      diffClip,
      ">>>"
    );
  }
  prompt.push("", "AGENT_FINAL_MESSAGE:", "<<<", clipped, ">>>");
  const messages = [
    { role: "system", content: "你是 git 提交信息生成器，只输出 JSON 对象。" },
    { role: "user", content: prompt.join("\n") }
  ];

  const perAttemptMs = Number(process.env.AUTOCOMMIT_AI_TIMEOUT_MS || 8000);
  const totalMs = Number(process.env.AUTOCOMMIT_AI_TOTAL_MS || 13000);
  const deadline = Date.now() + totalMs;
  const tried = new Set();

  for (const model of provider.models) {
    if (!model || tried.has(model)) continue;
    tried.add(model);
    const budget = deadline - Date.now();
    if (budget < 1000) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(perAttemptMs, budget));
    try {
      const streaming = provider.kind === "workbuddy";
      const anthropic = provider.kind === "zcode-anthropic";
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
      const body = anthropic
        ? {
            model: model,
            max_tokens: 600,
            temperature: 0.2,
            system: messages[0].content,
            messages: [{ role: "user", content: messages[1].content }]
          }
        : {
            model: model,
            messages,
            temperature: 0.2,
            max_tokens: 600,
            stream: streaming
          };
      const res = await fetch(provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) continue;
      const content = streaming
        ? await readSseText(res)
        : anthropic
          ? ((data => Array.isArray(data && data.content)
              ? data.content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("")
              : "")(await res.json()))
          : ((data => data && data.choices && data.choices[0] &&
              data.choices[0].message && data.choices[0].message.content)(await res.json()));
      if (typeof content !== "string" || !content.trim()) continue;
      const parsed = parseModelJson(content);
      const draft = validate(parsed, fallback);
      if (draft) {
        writeSensitive(collectSensitive(parsed));
        return draft;
      }
    } catch {
      // fall through and try the next model
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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
  const fallback = localDraft(text);

  if (!fallback.subject) {
    const n = changedFiles().length;
    fallback.subject = n ? "update " + n + (n === 1 ? " file" : " files") : "update workspace";
  }

  const draft = (await aiDraft(text, fallback)) || fallback;
  if (!draft.subject) draft.subject = fallback.subject;
  process.stdout.write(formatMessage(draft));
}

if (require.main === module) {
  // Never fail the hook: any unexpected error falls back to the shell's
  // generic subject.
  main().catch(() => {});
}

module.exports = { parsePayload, pickLine, cleanLine, localDraft, validate, formatMessage, loadProvider, loadManualProvider, loadWorkbuddyProvider, readSseText, changedFiles, readDiff, collectSensitive, writeSensitive };
