// Offline tests for the claude -p fallback in auto-commit-msg.cjs. They run
// the real helper against tests/fixtures/fake-claude.* (no network, no login)
// and assert the provider order, argument set, environment scrub and the
// recursion sentinel in auto-commit.sh.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT, "auto-commit-hook", "hooks", "auto-commit-msg.cjs");
const HOOK = path.join(ROOT, "auto-commit-hook", "hooks", "auto-commit.sh");
const FIXTURES = path.join(__dirname, "fixtures");
const WIN = process.platform === "win32";
const SHIM = WIN ? path.join(FIXTURES, "fake-claude.cmd") : path.join(FIXTURES, "fake-claude.sh");

if (!WIN) {
  try { fs.chmodSync(SHIM, 0o755); } catch {}
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "auto-commit-test-"));
after(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function tmp() {
  const dir = path.join(WORK, "case-" + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Strip every provider/session variable so a test starts from a clean slate,
// then apply the case-specific ones.
function baseEnv(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|AUTOCOMMIT_|CLAUDE|WORKBUDDY_|ZCODE_|CODEBUDDY_)/i.test(name)) {
      delete env[name];
    }
  }
  delete env.AI_AGENT;
  return { ...env, ...extra };
}

function cliCase(dir, extra) {
  return baseEnv({
    AUTOCOMMIT_AGENT: "claude",
    AUTOCOMMIT_CLAUDE_BIN: SHIM,
    AUTOCOMMIT_LLM_CONFIG: path.join(dir, "missing-llm.json"),
    AI_STATUS_OUT: path.join(dir, "ai.json"),
    SENSITIVE_OUT: path.join(dir, "sensitive.txt"),
    CHANGED: "a.txt",
    ...extra
  });
}

function runHelper(env, payload, timeoutMs = 30000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HELPER], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on("data", buf => { stdout += buf; });
    child.stderr.on("data", buf => { stderr += buf; });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "ai.json"), "utf8"));
}

test("claude -p fallback writes a conventional commit", async () => {
  const dir = tmp();
  const trace = path.join(dir, "trace.json");
  const env = cliCase(dir, {
    FAKE_MODE: "ok",
    FAKE_TRACE: trace,
    // Parent-session markers must be scrubbed from the child environment.
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli"
  });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了解析边界" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.match(res.stdout, /^fix: 修好解析边界/);
  const status = readStatus(dir);
  assert.strictEqual(status.status, "ok");
  assert.strictEqual(status.source, "claude");
  assert.strictEqual(status.transport, "cli");
  assert.strictEqual(status.model, "haiku");

  const seen = JSON.parse(fs.readFileSync(trace, "utf8"));
  assert.ok(seen.argv.includes("-p"));
  assert.ok(seen.argv.includes("--output-format"));
  assert.ok(seen.argv.includes("--settings"));
  assert.strictEqual(seen.argv[seen.argv.indexOf("--model") + 1], "haiku",
    "the CLI fallback must always ask for haiku");
  assert.ok(seen.argv.includes("--tools"));
  assert.strictEqual(seen.argv[seen.argv.indexOf("--tools") + 1], "",
    "an empty tool set must survive as an empty argument");
  assert.ok(seen.input.includes("AGENT_FINAL_MESSAGE"), "prompt must arrive on stdin");
  assert.ok(!seen.argv.some(arg => arg.includes("AGENT_FINAL_MESSAGE")),
    "prompt must not travel on argv");
  assert.strictEqual(seen.env.CLAUDECODE, null);
  assert.strictEqual(seen.env.AUTOCOMMIT_IN_HOOK, "1");

  assert.deepStrictEqual(seen.settings, { disableAllHooks: true });
});

test("staged sensitive paths from the CLI response are unstaged", async () => {
  const dir = tmp();
  const env = cliCase(dir, { FAKE_MODE: "sensitive" });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了解析边界" }));

  assert.strictEqual(res.code, 0, res.stderr);
  const sensitive = fs.readFileSync(path.join(dir, "sensitive.txt"), "utf8").trim();
  assert.strictEqual(sensitive, "a.txt", "only paths from CHANGED may be written");
});

test("stdout diagnostics before the JSON envelope are tolerated", async () => {
  const dir = tmp();
  const env = cliCase(dir, { FAKE_MODE: "noisy" });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了解析边界" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.match(res.stdout, /^fix: 修好解析边界/);
  assert.strictEqual(readStatus(dir).status, "ok");
});

test("claude -p failure is diagnostic and falls back to heuristics", async () => {
  const dir = tmp();
  const env = cliCase(dir, { FAKE_MODE: "fail" });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了问题" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.match(res.stdout, /^fix: /);
  const status = readStatus(dir);
  assert.strictEqual(status.status, "error");
  assert.strictEqual(status.transport, "cli");
  assert.strictEqual(status.attempts[0].code, 1);
  assert.match(status.attempts[0].error, /Not logged in/);
});

test("unusable stdout falls back without retrying every tier", async () => {
  const dir = tmp();
  const env = cliCase(dir, { FAKE_MODE: "garbage" });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了问题" }));

  assert.strictEqual(res.code, 0, res.stderr);
  const status = readStatus(dir);
  assert.strictEqual(status.status, "error");
  assert.match(status.attempts[0].error, /not usable commit JSON/);
});

test("claude -p is killed at the time budget", async () => {
  const dir = tmp();
  const env = cliCase(dir, {
    FAKE_MODE: "slow",
    AUTOCOMMIT_AI_TIMEOUT_MS: "1000",
    AUTOCOMMIT_AI_TOTAL_MS: "2500"
  });

  const started = Date.now();
  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "改了一下" }), 15000);
  const elapsed = Date.now() - started;

  assert.strictEqual(res.code, 0, res.stderr);
  assert.ok(elapsed < 10000, "helper must not hang on a slow child");
  const status = readStatus(dir);
  assert.strictEqual(status.status, "error");
  assert.match(status.attempts[0].error, /timeout after 1000 ms/);
});

test("direct HTTP credentials win over the CLI", async () => {
  const dir = tmp();
  const trace = path.join(dir, "trace.json");
  const env = cliCase(dir, {
    FAKE_MODE: "ok",
    FAKE_TRACE: trace,
    ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
    ANTHROPIC_AUTH_TOKEN: "test-token",
    ANTHROPIC_MODEL: "test-model"
  });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了问题" }));

  assert.strictEqual(res.code, 0, res.stderr);
  const status = readStatus(dir);
  assert.strictEqual(status.transport, "http");
  assert.ok(!fs.existsSync(trace), "the CLI must not run when an endpoint is configured");
});

test("saved llm-config outranks the CLI fallback", async () => {
  const dir = tmp();
  const trace = path.join(dir, "trace.json");
  const cfg = path.join(dir, "llm-config.json");
  fs.writeFileSync(cfg, JSON.stringify({
    url: "http://127.0.0.1:1/v1/messages",
    key: "test-key",
    model: ["test-model"]
  }));
  const env = cliCase(dir, {
    FAKE_MODE: "ok",
    FAKE_TRACE: trace,
    AUTOCOMMIT_LLM_CONFIG: cfg
  });

  const res = await runHelper(env,
    JSON.stringify({ last_assistant_message: "修复了问题" }));

  assert.strictEqual(res.code, 0, res.stderr);
  const status = readStatus(dir);
  assert.strictEqual(status.source, "manual");
  assert.strictEqual(status.transport, "http");
  assert.ok(!fs.existsSync(trace), "the CLI must not run when a manual config exists");
});

test("AUTOCOMMIT_NO_AI disables the fallback", async () => {
  const dir = tmp();
  const trace = path.join(dir, "trace.json");
  const env = cliCase(dir, {
    FAKE_MODE: "ok",
    FAKE_TRACE: trace,
    AUTOCOMMIT_NO_AI: "1"
  });

  await runHelper(env, JSON.stringify({ last_assistant_message: "修复了问题" }));

  assert.strictEqual(readStatus(dir).status, "disabled");
  assert.ok(!fs.existsSync(trace), "the CLI must not run when AI is disabled");
});

test("AUTOCOMMIT_IN_HOOK stops the shell hook before any git work", () => {
  const repo = tmp();
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "change\n");

  const res = spawnSync("bash", [HOOK], {
    cwd: repo,
    encoding: "utf8",
    timeout: 20000,
    input: JSON.stringify({ last_assistant_message: "x", stop_hook_active: false }),
    env: { ...process.env, AUTOCOMMIT_IN_HOOK: "1", CLAUDE_PROJECT_DIR: repo }
  });

  assert.strictEqual(res.status, 0, res.stderr);
  const log = spawnSync("git", ["-C", repo, "log", "--oneline"], { encoding: "utf8" });
  assert.strictEqual(String(log.stdout || "").trim(), "", "no commit may be created");
});
