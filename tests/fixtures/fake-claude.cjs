#!/usr/bin/env node
// Offline stand-in for the `claude` CLI used by tests/auto-commit-cli.test.cjs.
// It reads the prompt from stdin, records argv/env for assertions, and emits a
// CLI-shaped JSON envelope. FAKE_MODE selects ok | fail | slow | garbage.
"use strict";

const fs = require("fs");

const mode = process.env.FAKE_MODE || "ok";
const trace = process.env.FAKE_TRACE;

let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}

// The helper runs two independent prompts (message and screening); keep their
// traces apart so each test can inspect the one it cares about.
const traceFile = trace
  ? (input.includes("AGENT_FINAL_MESSAGE") ? trace : trace + ".screen")
  : "";
if (traceFile) {
  const env = {};
  for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AUTOCOMMIT_IN_HOOK", "ANTHROPIC_BASE_URL"]) {
    env[name] = process.env[name] == null ? null : process.env[name];
  }
  const argv = process.argv.slice(2);
  // Capture the added settings layer before the helper removes its temp dir.
  let settings = null;
  const at = argv.indexOf("--settings");
  if (at >= 0 && argv[at + 1]) {
    try { settings = JSON.parse(fs.readFileSync(argv[at + 1], "utf8")); } catch {}
  }
  fs.writeFileSync(traceFile, JSON.stringify({ argv, input, env, settings }, null, 2), "utf8");
}

const result = JSON.stringify({
  type: "fix",
  subject: "修好解析边界",
  body: ["补充空输入处理"],
  // "sensitive" also includes a path that is not staged, which the helper must
  // reject; the trace test checks the staged one is written out.
  sensitiveFiles: mode === "sensitive" ? ["a.txt", "not-staged.txt"] : []
});

function envelope(text) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "fake-session",
    num_turns: 1,
    total_cost_usd: 0
  });
}

if (mode === "slow") {
  setTimeout(() => process.stdout.write(envelope(result)), 10000);
} else if (mode === "fail") {
  process.stderr.write("Not logged in\n");
  process.exit(1);
} else if (mode === "garbage") {
  process.stdout.write("this is not a JSON envelope\n");
} else if (mode === "noisy") {
  // Real CLIs can print diagnostics on stdout before the result envelope.
  process.stdout.write('[claude-code:unrecognized_model] {"model":"x"}\n');
  process.stdout.write(envelope(result));
} else {
  process.stdout.write(envelope(result));
}
