// Offline tests for the sensitive-file gate: exact path handling (non-ASCII
// names, Windows separators, unstage verification) and the deterministic
// content scan that must keep working when the model is disabled or absent.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HELPER = path.join(ROOT, "auto-commit-hook", "hooks", "auto-commit-msg.cjs");
const HOOK = path.join(ROOT, "auto-commit-hook", "hooks", "auto-commit.sh");

// Assembled at runtime so this test file does not itself look like a secret to
// the gate it exercises when the repository's own hook commits it.
const PRIVATE_KEY = "-----BEGIN " + "RSA PRIVATE KEY" + "-----";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const DB_URL = "postgres" + "://app:" + "hunter22x@db.internal/app";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "auto-commit-sensitive-"));
after(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function tmp() {
  const dir = path.join(WORK, "case-" + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseEnv(extra) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|AUTOCOMMIT_|CLAUDE|WORKBUDDY_|ZCODE_|CODEBUDDY_)/i.test(name)) {
      delete env[name];
    }
  }
  delete env.AI_AGENT;
  return {
    ...env,
    AUTOCOMMIT_NO_AI: "1",
    AUTOCOMMIT_CONFIG: path.join(WORK, "missing-config.json"),
    ...extra
  };
}

function writeChanged(dir, files) {
  const file = path.join(dir, "changed.bin");
  fs.writeFileSync(file, files.map(f => f + "\0").join(""));
  return file;
}

function writeDiff(dir, repoPath, addedLines) {
  const file = path.join(dir, "diff.txt");
  fs.writeFileSync(file, [
    "diff --git a/" + repoPath + " b/" + repoPath,
    "--- a/" + repoPath,
    "+++ b/" + repoPath,
    "@@ -0,0 +1,1 @@",
    ...addedLines.map(line => "+" + line),
    ""
  ].join("\n"));
  return file;
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

function scanCase(dir, files, repoPath, addedLines) {
  const out = path.join(dir, "sensitive.txt");
  const status = path.join(dir, "ai.json");
  return {
    env: baseEnv({
      CHANGED_FILE: writeChanged(dir, files),
      DIFF_FILE: writeDiff(dir, repoPath, addedLines),
      SENSITIVE_OUT: out,
      AI_STATUS_OUT: status
    }),
    out,
    status
  };
}

function readOut(out) {
  try {
    return fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("deterministic scan flags a private key even with AI disabled", async () => {
  const dir = tmp();
  const c = scanCase(dir, ["config/keys.txt"], "config/keys.txt", [PRIVATE_KEY]);

  const res = await runHelper(c.env,
    JSON.stringify({ last_assistant_message: "加了一个配置文件" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(readOut(c.out), ["config/keys.txt"]);
  const status = JSON.parse(fs.readFileSync(c.status, "utf8"));
  assert.strictEqual(status.status, "disabled");
  assert.deepStrictEqual(status.sensitive, {
    screened: "local",
    local: 1,
    model: 0,
    unmatched: 0,
    truncated: false,
    excluded: 1,
    screen: { status: "disabled", reason: "AUTOCOMMIT_NO_AI=1" }
  });
});

test("noAiScreen disables only the model screen, not the deterministic scan", async () => {
  const dir = tmp();
  const c = scanCase(dir, ["config/keys.txt"], "config/keys.txt", [PRIVATE_KEY]);
  c.env.AUTOCOMMIT_NO_AI = "0";
  c.env.AUTOCOMMIT_NO_AI_SCREEN = "1";
  // Keep the message task offline: this agent has no provider env here.
  c.env.AUTOCOMMIT_AGENT = "workbuddy";

  const res = await runHelper(c.env,
    JSON.stringify({ last_assistant_message: "加了一个配置文件" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(readOut(c.out), ["config/keys.txt"],
    "the deterministic scan must still exclude the file");
  const status = JSON.parse(fs.readFileSync(c.status, "utf8"));
  assert.strictEqual(status.sensitive.local, 1);
  assert.deepStrictEqual(status.sensitive.screen, {
    status: "disabled",
    reason: "AUTOCOMMIT_NO_AI_SCREEN=1"
  });
});

test("screening still runs when the final message is empty", async () => {
  const dir = tmp();
  const c = scanCase(dir, ["src/db.ts"], "src/db.ts", ["const url = \"" + DB_URL + "\";"]);
  // The message call stops before the provider lookup, but the screening call
  // still runs. Pin the agent to one whose provider env is absent, so this
  // stays offline instead of finding the real `claude` on PATH.
  delete c.env.AUTOCOMMIT_NO_AI;
  c.env.AUTOCOMMIT_AGENT = "workbuddy";

  const res = await runHelper(c.env, JSON.stringify({}));

  assert.strictEqual(res.code, 0, res.stderr);
  // No draft and no message: the shell writes the placeholder after the gate.
  assert.strictEqual(res.stdout, "");
  assert.deepStrictEqual(readOut(c.out), ["src/db.ts"]);
  const status = JSON.parse(fs.readFileSync(c.status, "utf8"));
  assert.strictEqual(status.status, "skipped");
  assert.strictEqual(status.sensitive.local, 1);
  assert.strictEqual(status.sensitive.screen.status, "unavailable");
});

test("non-ASCII diff headers resolve to the exact staged path", async () => {
  const dir = tmp();
  const repoPath = "中文/配置.txt";
  const c = scanCase(dir, [repoPath], repoPath, ["token = \"" + AWS_KEY + "\""]);

  const res = await runHelper(c.env,
    JSON.stringify({ last_assistant_message: "更新配置" }));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(readOut(c.out), [repoPath]);
});

test("model paths with Windows separators or case resolve to the staged spelling", () => {
  const dir = tmp();
  const changed = writeChanged(dir, ["src/Config.ts", "src/other.ts"]);
  const saved = process.env.CHANGED_FILE;
  process.env.CHANGED_FILE = changed;
  try {
    const { collectSensitive } = require(HELPER);
    const reported = process.platform === "win32"
      ? "SRC\\Config.TS"
      : "src\\Config.ts";
    assert.deepStrictEqual(collectSensitive({ sensitiveFiles: [reported] }).files,
      ["src/Config.ts"]);
    const miss = collectSensitive({ sensitiveFiles: ["nope.txt", "src/other.ts"] });
    assert.deepStrictEqual(miss.files, ["src/other.ts"]);
    assert.strictEqual(miss.unmatched.length, 1);
  } finally {
    if (saved === undefined) delete process.env.CHANGED_FILE;
    else process.env.CHANGED_FILE = saved;
  }
});

// Loopback Anthropic-style endpoint: answers the message prompt and the
// screening prompt differently and records what each request carried.
function startServer() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", buf => { body += buf; });
      req.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        const user = parsed && Array.isArray(parsed.messages) &&
          parsed.messages[0] ? String(parsed.messages[0].content || "") : "";
        requests.push({
          max_tokens: parsed && parsed.max_tokens,
          system: parsed && parsed.system,
          user
        });
        const text = user.includes("FILE_LIST")
          ? JSON.stringify({ sensitiveFiles: ["a.txt"] })
          : JSON.stringify({ type: "fix", subject: "修好解析边界", body: ["补充空输入处理"] });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server, requests, port: server.address().port
    }));
  });
}

test("HTTP screening is a separate request with its own budget", async () => {
  const dir = tmp();
  const { server, requests, port } = await startServer();
  try {
    const env = baseEnv({
      AUTOCOMMIT_AGENT: "claude",
      AUTOCOMMIT_CONFIG: path.join(dir, "missing-config.json"),
      AUTOCOMMIT_LLM_URL: "http://127.0.0.1:" + port + "/v1/messages",
      AUTOCOMMIT_LLM_KEY: "test-key",
      AUTOCOMMIT_LLM_MODEL: "test-model",
      CHANGED_FILE: writeChanged(dir, ["a.txt"]),
      DIFF_FILE: writeDiff(dir, "a.txt", ["const token = 1;"]),
      SENSITIVE_OUT: path.join(dir, "sensitive.txt"),
      AI_STATUS_OUT: path.join(dir, "ai.json")
    });
    delete env.AUTOCOMMIT_NO_AI;

    const res = await runHelper(env,
      JSON.stringify({ last_assistant_message: "修复了解析边界" }));

    assert.strictEqual(res.code, 0, res.stderr);
    assert.strictEqual(requests.length, 2, "one message call and one screening call");
    const message = requests.find(r => r.user.includes("AGENT_FINAL_MESSAGE"));
    const screen = requests.find(r => r.user.includes("FILE_LIST"));
    assert.ok(message && screen, "both prompts must be sent");
    assert.strictEqual(message.max_tokens, 600);
    assert.strictEqual(screen.max_tokens, 200);
    assert.ok(!message.user.includes("const token = 1;"),
      "the message prompt must not carry the diff");
    assert.ok(screen.user.includes("const token = 1;"),
      "added lines must reach the screening prompt");
    assert.ok(!screen.user.includes("AGENT_FINAL_MESSAGE"),
      "the agent reply must not be sent to the screening call");

    assert.match(res.stdout, /^fix: 修好解析边界/);
    assert.deepStrictEqual(readOut(path.join(dir, "sensitive.txt")), ["a.txt"]);
    const status = JSON.parse(fs.readFileSync(path.join(dir, "ai.json"), "utf8"));
    assert.strictEqual(status.status, "ok");
    assert.strictEqual(status.sensitive.screened, "model+local");
    assert.strictEqual(status.sensitive.screen.status, "ok");
    assert.strictEqual(status.sensitive.screen.transport, "http");
  } finally {
    server.close();
  }
});

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function initRepo() {
  const repo = tmp();
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "test"]);
  return repo;
}

function runHook(repo, state) {
  return spawnSync("bash", [HOOK], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30000,
    input: JSON.stringify({ last_assistant_message: "加了一个文件" }),
    env: baseEnv({
      AUTOCOMMIT_NODE: process.execPath,
      AUTOCOMMIT_STATE_DIR: state,
      CLAUDE_PROJECT_DIR: repo
    })
  });
}

test("hook excludes a non-ASCII secret name without naming it in the message", () => {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, "中文"));
  fs.writeFileSync(path.join(repo, "中文", ".env"), "TOKEN=abc\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "hello\n");

  const res = runHook(repo, tmp());
  assert.strictEqual(res.status, 0, res.stderr);

  const names = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout;
  assert.match(names, /notes\.txt/);
  assert.ok(!names.includes(".env"), "the .env file must not be committed");

  const worktree = git(repo,
    ["-c", "core.quotePath=false", "status", "--porcelain", "-uall"]).stdout;
  assert.match(worktree, /中文\/\.env/, "the excluded file stays in the worktree");

  const body = git(repo, ["log", "-1", "--format=%B"]).stdout;
  assert.ok(!body.includes("中文/.env"), "the excluded path must not appear in the message");
  assert.ok(!/excluded|sensitive/i.test(body), "the message must not mention the gate");
  const subject = git(repo, ["log", "-1", "--format=%s"]).stdout.trim();
  assert.strictEqual(subject, "chore: update notes.txt");
});

test("hook records a run when the name gate excludes everything", () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, ".env"), "TOKEN=abc\n");
  const state = tmp();

  const res = runHook(repo, state);
  assert.strictEqual(res.status, 0, res.stderr);

  assert.strictEqual(git(repo, ["log", "--oneline"]).stdout.trim(), "",
    "nothing may be committed");
  const last = JSON.parse(fs.readFileSync(path.join(state, "last-run.json"), "utf8"));
  assert.strictEqual(last.status, "ok");
  assert.strictEqual(last.skipped, "sensitive");
});

test("hook records a run when the content gate excludes everything", () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "settings.txt"), "key: " + AWS_KEY + "\n");
  const state = tmp();

  const res = runHook(repo, state);
  assert.strictEqual(res.status, 0, res.stderr);

  assert.strictEqual(git(repo, ["log", "--oneline"]).stdout.trim(), "",
    "nothing may be committed");
  const last = JSON.parse(fs.readFileSync(path.join(state, "last-run.json"), "utf8"));
  assert.strictEqual(last.status, "ok");
  assert.strictEqual(last.skipped, "sensitive");
  assert.strictEqual(last.ai.sensitive.screened, "local");
  assert.strictEqual(last.ai.sensitive.excluded, 1);
});

test("hook unstages a content-level secret when no model runs", () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, "settings.txt"), "key: " + AWS_KEY + "\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "hello\n");

  const res = runHook(repo, tmp());
  assert.strictEqual(res.status, 0, res.stderr);

  const names = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout;
  assert.match(names, /notes\.txt/);
  assert.ok(!names.includes("settings.txt"),
    "a file with a high-confidence secret must not be committed");

  const body = git(repo, ["log", "-1", "--format=%B"]).stdout;
  assert.ok(!body.includes("settings.txt"),
    "the excluded path must not appear in the message");
  assert.ok(!/excluded|sensitive/i.test(body), "the message must not mention the gate");
  const subject = git(repo, ["log", "-1", "--format=%s"]).stdout.trim();
  assert.strictEqual(subject, "chore: update notes.txt",
    "the fallback names only what survived the gate");
});
