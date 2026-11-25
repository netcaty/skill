// Offline tests for the sensitive-file gate: exact path handling (non-ASCII
// names, Windows separators, unstage verification) and the deterministic
// content scan that must keep working when the model is disabled or absent.
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
    AUTOCOMMIT_LLM_CONFIG: path.join(WORK, "missing-llm.json"),
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
    excluded: 1
  });
});

test("screening still runs when the final message is empty", async () => {
  const dir = tmp();
  const c = scanCase(dir, ["src/db.ts"], "src/db.ts", ["const url = \"" + DB_URL + "\";"]);
  // No model is consulted for an empty message: the helper stops before the
  // provider lookup, so this is offline without needing AUTOCOMMIT_NO_AI.
  delete c.env.AUTOCOMMIT_NO_AI;

  const res = await runHelper(c.env, JSON.stringify({}));

  assert.strictEqual(res.code, 0, res.stderr);
  assert.deepStrictEqual(readOut(c.out), ["src/db.ts"]);
  const status = JSON.parse(fs.readFileSync(c.status, "utf8"));
  assert.strictEqual(status.status, "skipped");
  assert.strictEqual(status.sensitive.local, 1);
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
  const savedChanged = process.env.CHANGED;
  process.env.CHANGED_FILE = changed;
  delete process.env.CHANGED;
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
    if (savedChanged === undefined) delete process.env.CHANGED;
    else process.env.CHANGED = savedChanged;
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

test("hook excludes a non-ASCII secret name and keeps claiming it", () => {
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
  assert.match(body, /中文\/\.env/, "the exclusion is reported in the commit body");
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
  assert.match(body, /settings\.txt/);
});
