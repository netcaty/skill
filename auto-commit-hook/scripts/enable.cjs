#!/usr/bin/env node
// Resume a paused auto-commit hook by removing the marker created by
// disable.cjs. The hook registration was never removed, so no install is
// needed and the next Stop runs normally.
"use strict";

const lib = require("./lib.cjs");

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node enable.cjs [options]",
      "",
      "Remove the pause marker so the auto-commit hook runs again on the next",
      "Stop. The hook registration is untouched, so no install is needed.",
      "",
      "Options:",
      "  --agent zcode|workbuddy|claude  Target agent (default: auto-detected)",
      "  --dry-run                       Print the planned change without writing",
      "  --json                          Machine-readable result"
    ].join("\n"));
    return;
  }

  const wasDisabled = opts.dryRun
    ? lib.readPause(opts.agent) !== null
    : lib.clearPause(opts.agent);
  const result = {
    agent: opts.agent,
    agentSource: opts.agentSource,
    enabled: true,
    wasDisabled,
    pauseFile: lib.pauseFile(opts.agent),
    dryRun: opts.dryRun
  };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!wasDisabled) {
    console.log("Auto-commit hook is not paused for " + opts.agent + ".");
    return;
  }
  console.log((opts.dryRun ? "Would resume" : "Resumed") +
    " the auto-commit hook for " + opts.agent + ".");
  console.log("  marker : " + result.pauseFile + (opts.dryRun ? " (would remove)" : " (removed)"));
  console.log("The next Stop commits again; no reinstall is needed.");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
