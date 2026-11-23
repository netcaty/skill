#!/usr/bin/env node
// Pause the auto-commit hook without editing the agent's config.
//
// The Stop hook registration stays in place; a marker file in the agent asset
// directory makes hooks/auto-commit.sh exit before any git work. Resuming is
// `run.sh enable` (the marker is removed). Refreshing the assets with
// `install` preserves the marker, and `uninstall` clears it.
"use strict";

const lib = require("./lib.cjs");

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node disable.cjs [options]",
      "",
      "Pause the auto-commit hook but keep its registration. The hook exits",
      "before any git work until `enable` removes the marker. Unlike uninstall,",
      "this never rewrites the agent config and takes effect on the next Stop.",
      "",
      "Options:",
      "  --agent zcode|workbuddy|claude  Target agent (default: auto-detected)",
      "  --project <dir>                 Workspace root, used to find an installed",
      "                                  workspace-scope registration",
      "  --dry-run                       Print the planned change without writing",
      "  --json                          Machine-readable result"
    ].join("\n"));
    return;
  }

  const existing = lib.readPause(opts.agent);
  const hooked = lib.hookedConfigs(opts, lib.readState(opts.agent));
  const data = existing ||
    (opts.dryRun
      ? { at: new Date().toISOString(), agent: opts.agent }
      : lib.writePause(opts.agent, {}));

  const result = {
    agent: opts.agent,
    agentSource: opts.agentSource,
    disabled: true,
    already: !!existing,
    since: data.at,
    pauseFile: lib.pauseFile(opts.agent),
    hookedConfigs: hooked,
    dryRun: opts.dryRun
  };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (existing) {
    console.log("Auto-commit hook is already paused for " + opts.agent + ".");
  } else {
    console.log((opts.dryRun ? "Would pause" : "Paused") +
      " the auto-commit hook for " + opts.agent +
      " (registration kept; no config was rewritten).");
  }
  console.log("  marker : " + result.pauseFile);
  if (result.since) console.log("  since  : " + result.since);
  if (hooked.length) {
    console.log("  config : " + hooked.join(", "));
  } else {
    console.log("  note   : no installed registration found; the marker applies if one is added later");
  }
  console.log("Resume with: bash scripts/run.sh enable");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
