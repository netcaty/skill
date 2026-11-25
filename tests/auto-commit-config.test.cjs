// Offline tests for scripts/config.cjs (the config.json writer/show) and the
// hook-side config resolution. No network, no real install directory: every
// case points AUTOCOMMIT_CONFIG into a temp dir.
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG = path.join(ROOT, "auto-commit-hook", "scripts", "config.cjs");
const HELPER = path.join(ROOT, "auto-commit-hook", "hooks", "auto-commit-msg.cjs");
const LIB = path.join(ROOT, "auto-commit-hook", "scripts", "lib.cjs");
const WIN = process.platform === "win32";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "auto-commit-config-test-"));
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
  return { ...env, ...extra };
}

function configPath(dir) {
  return path.join(dir, "config.json");
}

function run(dir, args, extra) {
  return spawnSync(process.execPath, [CONFIG, ...args], {
    env: baseEnv({ AUTOCOMMIT_CONFIG: configPath(dir), ...extra }),
    encoding: "utf8",
    windowsHide: true
  });
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
}

test("saving creates config.json and --show masks the key", () => {
  const dir = tmp();
  const save = run(dir, ["--url", "https://example.com/v1/messages",
    "--key", "secret-test-key", "--model", "a,b"]);
  assert.strictEqual(save.status, 0, save.stderr);
  assert.ok(!save.stdout.includes("secret-test-key"), "the save output must mask the key");
  const data = readConfig(dir);
  assert.strictEqual(data.url, "https://example.com/v1/messages");
  assert.deepStrictEqual(data.model, ["a", "b"]);
  assert.ok(data.savedAt);

  const show = run(dir, ["--show"]);
  assert.strictEqual(show.status, 0, show.stderr);
  assert.ok(!show.stdout.includes("secret-test-key"), "the show output must mask the key");
  assert.match(show.stdout, /\[config\]/);

  const json = run(dir, ["--show", "--json"]);
  assert.strictEqual(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.notStrictEqual(parsed.saved.key, "secret-test-key");
  assert.notStrictEqual(parsed.effective.key.value, "secret-test-key");

  if (!WIN) {
    assert.strictEqual(fs.statSync(configPath(dir)).mode & 0o777, 0o600);
  }
});

test("saving merges existing and unknown keys", () => {
  const dir = tmp();
  fs.writeFileSync(configPath(dir), JSON.stringify({
    noAi: true, aiTimeoutMs: 5000, unknown: "keep"
  }));
  const res = run(dir, ["--url", "https://example.com/v1/messages",
    "--key", "test-key", "--model", "test-model"]);
  assert.strictEqual(res.status, 0, res.stderr);
  const data = readConfig(dir);
  assert.strictEqual(data.noAi, true);
  assert.strictEqual(data.aiTimeoutMs, 5000);
  assert.strictEqual(data.unknown, "keep");
  assert.strictEqual(data.url, "https://example.com/v1/messages");
});

test("--set and --unset apply typed values and preserve the rest", () => {
  const dir = tmp();
  const set = run(dir, ["--set", "noAi=true", "--set", "aiTimeoutMs=12000",
    "--set", "claudeBin=/opt/claude", "--set", "sourceDir=."]);
  assert.strictEqual(set.status, 0, set.stderr);
  let data = readConfig(dir);
  assert.strictEqual(data.noAi, true);
  assert.strictEqual(data.aiTimeoutMs, 12000);
  assert.strictEqual(data.claudeBin, "/opt/claude");
  assert.strictEqual(data.sourceDir, path.resolve("."));

  const unset = run(dir, ["--unset", "noAi", "--unset", "aiTimeoutMs"]);
  assert.strictEqual(unset.status, 0, unset.stderr);
  data = readConfig(dir);
  assert.ok(!("noAi" in data));
  assert.ok(!("aiTimeoutMs" in data));
  assert.strictEqual(data.claudeBin, "/opt/claude");
});

test("--set rejects secrets, unknown keys and malformed values", () => {
  const dir = tmp();
  const cases = [
    ["--set", "key=verysecretvalue"],
    ["--set", "url=https://example.com"],
    ["--set", "model=x"],
    ["--set", "unknown=1"],
    ["--set", "noAi"],
    ["--set", "noAi=maybe"],
    ["--set", "aiTimeoutMs=abc"],
    ["--set", "aiTimeoutMs=500"]
  ];
  for (const args of cases) {
    const res = run(dir, args);
    assert.notStrictEqual(res.status, 0, args.join(" ") + " should fail");
    assert.match(res.stderr, /^Error: /);
    assert.ok(!res.stderr.includes("verysecretvalue"), "a rejected value must not be echoed");
  }
  assert.ok(!fs.existsSync(configPath(dir)), "rejected writes must not create a file");
});

test("--show --json reports effective env overrides with sources", () => {
  const dir = tmp();
  fs.writeFileSync(configPath(dir), JSON.stringify({
    aiTimeoutMs: 12000, noAi: false
  }));
  const res = run(dir, ["--show", "--json"], {
    AUTOCOMMIT_AI_TIMEOUT_MS: "1000",
    AUTOCOMMIT_LLM_URL: "https://env.example/v1/messages",
    AUTOCOMMIT_LLM_KEY: "env-secret-key",
    AUTOCOMMIT_LLM_MODEL: "env-model"
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepStrictEqual(parsed.effective.aiTimeoutMs, { value: 1000, source: "env" });
  assert.strictEqual(parsed.effective.noAi.source, "config");
  assert.strictEqual(parsed.effective.url.source, "env");
  assert.strictEqual(parsed.effective.key.source, "env");
  assert.ok(!res.stdout.includes("env-secret-key"), "env keys are masked too");
});

test("saving refuses to overwrite invalid JSON", () => {
  const dir = tmp();
  fs.writeFileSync(configPath(dir), "{ not json");
  const before = fs.readFileSync(configPath(dir));
  const res = run(dir, ["--set", "noAi=true"]);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /refusing to overwrite invalid/);
  assert.deepStrictEqual(fs.readFileSync(configPath(dir)), before);
});

test("--clear removes the whole file", () => {
  const dir = tmp();
  assert.strictEqual(run(dir, ["--set", "noAi=true"]).status, 0);
  const res = run(dir, ["--clear"]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Cleared /);
  assert.ok(!fs.existsSync(configPath(dir)));
});

test("hook runtimeSettings resolves env > config and ignores settings-only files as providers", () => {
  const helper = require(HELPER);
  const dir = tmp();
  fs.writeFileSync(configPath(dir), JSON.stringify({
    aiTimeoutMs: 5000,
    aiTotalMs: 6000,
    noAi: false
  }));
  const keys = ["AUTOCOMMIT_CONFIG", "AUTOCOMMIT_AI_TIMEOUT_MS", "AUTOCOMMIT_NO_AI"];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    process.env.AUTOCOMMIT_CONFIG = configPath(dir);
    process.env.AUTOCOMMIT_AI_TIMEOUT_MS = "1000";
    delete process.env.AUTOCOMMIT_NO_AI;
    let settings = helper.runtimeSettings();
    assert.strictEqual(settings.manual, null);
    assert.strictEqual(settings.manualIncomplete, false);
    assert.strictEqual(settings.aiTimeoutMs, 1000);
    assert.strictEqual(settings.aiTotalMs, 6000);
    assert.deepStrictEqual(settings.noAi, { value: false, source: "config" });

    process.env.AUTOCOMMIT_NO_AI = "0";
    settings = helper.runtimeSettings();
    assert.deepStrictEqual(settings.noAi, { value: false, source: "env" });

    process.env.AUTOCOMMIT_NO_AI = "1";
    assert.strictEqual(helper.noAiReason(helper.runtimeSettings()), "AUTOCOMMIT_NO_AI=1");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("claudeBin resolution prefers env over config.json", () => {
  const helper = require(HELPER);
  const dir = tmp();
  fs.writeFileSync(configPath(dir), JSON.stringify({ claudeBin: "/cfg/claude" }));
  const keys = ["AUTOCOMMIT_CONFIG", "AUTOCOMMIT_CLAUDE_BIN"];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    process.env.AUTOCOMMIT_CONFIG = configPath(dir);
    delete process.env.AUTOCOMMIT_CLAUDE_BIN;
    assert.strictEqual(helper.runtimeSettings().claudeBin, "/cfg/claude");

    process.env.AUTOCOMMIT_CLAUDE_BIN = "/env/claude";
    assert.strictEqual(helper.runtimeSettings().claudeBin, "/env/claude");
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("resolveSourceDir uses env, then config.json sourceDir", () => {
  const lib = require(LIB);
  const dir = tmp();
  const fromConfig = tmp();
  fs.writeFileSync(configPath(dir), JSON.stringify({ sourceDir: fromConfig }));
  const keys = ["AUTOCOMMIT_CONFIG", "AUTOCOMMIT_SOURCE_DIR"];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  try {
    process.env.AUTOCOMMIT_CONFIG = configPath(dir);
    delete process.env.AUTOCOMMIT_SOURCE_DIR;
    assert.strictEqual(lib.resolveSourceDir(""), path.resolve(fromConfig));

    process.env.AUTOCOMMIT_SOURCE_DIR = dir;
    assert.strictEqual(lib.resolveSourceDir(""), path.resolve(dir));
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
