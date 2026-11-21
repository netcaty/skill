"use strict";

const lib = require("./lib.cjs");

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node install.cjs [options]",
      "",
      "Options:",
      "  --agent zcode|workbuddy  Target agent's config format; auto-detected from",
      "                           the session environment when omitted",
      "  --scope workspace|user   Config scope (default: user)",
      "  --project <dir>          Workspace root (default: CODEBUDDY_PROJECT_DIR /",
      "                           CLAUDE_PROJECT_DIR / ZCODE_PROJECT_DIR / cwd)",
      "  --config <file>          Explicit hooks config path",
      "  --timeout <ms>           Hook timeout, default 30000",
      "  --force                  Install even if the other scope already has the hook",
      "  --dry-run                Print the planned change without writing",
      "  --json                   Machine-readable result"
    ].join("\n"));
    return;
  }

  const project = lib.projectDir(opts);
  const cfgPath = lib.configPath(opts);
  const bash = lib.findBash(opts.agent);
  if (!bash) {
    throw new Error("bash not found. Install Git for Windows (it includes bash) or set AUTOCOMMIT_BASH.");
  }

  const other = lib.otherConfigPath(opts);
  if (other && lib.installStatusIn(other) === true && !opts.force) {
    throw new Error("Auto-commit hook is already installed at " + other +
      ". Uninstall it first, or pass --force to install both scopes (two commits per turn).");
  }

  const { exists, data } = lib.readConfig(cfgPath);
  const previousEnabled = lib.previousEnabledValue(data);
  const existingHooks = lib.countAllHooks(data);
  const script = lib.installScript(opts.agent);
  // ZCode takes the script as a POSIX argv entry (safe on Windows); WorkBuddy
  // embeds it in a quoted forward-slash command string.
  const scriptArg = opts.agent === "workbuddy" ? script : lib.toPosixPath(script);
  lib.ensureStopHook(data, bash, scriptArg, opts.timeoutMs, opts.agent);
  const git = lib.gitCheck(project);

  let backup = "";
  if (!opts.dryRun) {
    lib.installAssets(opts.agent);
    backup = lib.writeConfig(cfgPath, data);
    lib.recordInstall(cfgPath, previousEnabled, exists, opts.agent);
  }

  const result = {
    agent: opts.agent,
    agentSource: opts.agentSource,
    scope: opts.scope,
    project,
    configPath: cfgPath,
    configExisted: exists,
    installDir: lib.installDir(opts.agent),
    script,
    helper: lib.installHelper(opts.agent),
    bash,
    hookArgs: opts.agent === "workbuddy" ? undefined : [scriptArg],
    hookCommand: opts.agent === "workbuddy"
      ? lib.hookCommandWorkbuddy(bash, script)
      : undefined,
    timeoutMs: opts.timeoutMs,
    backup,
    dryRun: opts.dryRun,
    previousEnabled,
    existingOtherHooks: existingHooks,
    git
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log((opts.dryRun ? "Would install" : "Installed") +
    " auto-commit Stop hook (" + opts.agent +
    (opts.agentSource === "detected" ? ", detected from environment" : "") +
    ", " + opts.scope + " scope)");
  console.log("  config : " + cfgPath);
  console.log("  scripts: " + script);
  console.log("  bash   : " + bash);
  if (backup) console.log("  backup : " + backup);
  if (!exists) console.log("  note   : created a new config file");
  if (previousEnabled !== true && existingHooks > 0) {
    console.log("");
    console.log("Warning: setting hooks.enabled=true also enables " + existingHooks +
      " existing configuration hook(s) in this file.");
  }
  if (!git.ok) {
    console.log("");
    console.log("Warning: git cannot access " + project + " under the current user.");
    console.log("The hook will exit silently until this is fixed:");
    console.log("  git config --global --add safe.directory " + project.replace(/\\/g, "/"));
  }
  console.log("");
  console.log("Note: each turn this hook stages all workspace changes (git add -A) and commits with --no-verify.");
  console.log("Start a new session (or reopen the workspace) for the hook to take effect.");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
