"use strict";

const path = require("path");
const lib = require("./lib.cjs");

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node install.cjs [options]",
      "",
      "Options:",
      "  --agent zcode|workbuddy|claude",
      "                           Target agent's config format; auto-detected from",
      "                           the session environment when omitted",
      "  --scope workspace|user   Config scope (default: user)",
      "  --project <dir>          Workspace root (default: CODEBUDDY_PROJECT_DIR /",
      "                           CLAUDE_PROJECT_DIR / ZCODE_PROJECT_DIR / cwd)",
      "  --config <file>          Explicit hooks config path",
      "  --timeout <ms>           Hook timeout, default 30000",
      "  --force                  Install even if another config already has the hook",
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
  // Claude Code merges user settings and both project files, so check all of
  // them: an older install in settings.json must not coexist with the new
  // workspace target settings.local.json.
  const checkedConfigs = opts.agent === "claude" && !opts.config
    ? lib.claudeSettingsFiles(project)
    : [other].filter(Boolean);
  const conflicts = checkedConfigs
    .filter(file => path.resolve(file).toLowerCase() !== path.resolve(cfgPath).toLowerCase())
    .filter(file => lib.installStatusIn(file) === true);
  if (conflicts.length && !opts.force) {
    throw new Error("Auto-commit hook is already installed at " + conflicts.join(", ") +
      ". Uninstall it first, or pass --force to install both (two commits per turn).");
  }

  const { exists, data } = lib.readConfig(cfgPath);
  const previousEnabled = lib.previousEnabledValue(data);
  const existingHooks = lib.countAllHooks(data);
  // Claude Code merges user/project/local settings, so a disable switch in any
  // of them silently stops the hook.
  const disabledBy = opts.agent === "claude" ? lib.claudeDisableFlags(project) : [];
  const script = lib.installScript(opts.agent);
  // ZCode takes the script as a POSIX argv entry (safe on Windows); the
  // command-string agents (workbuddy, claude) embed the native path in a
  // quoted forward-slash command string.
  const usesCommandString = opts.agent !== "zcode";
  const scriptArg = usesCommandString ? script : lib.toPosixPath(script);
  lib.ensureStopHook(data, bash, scriptArg, opts.timeoutMs, opts.agent);
  const git = lib.gitCheck(project);

  let backup = "";
  if (!opts.dryRun) {
    lib.installAssets(opts.agent);
    backup = lib.writeConfig(cfgPath, data, opts.agent);
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
    hookArgs: usesCommandString ? undefined : [scriptArg],
    hookCommand: usesCommandString
      ? lib.hookCommandWorkbuddy(bash, script)
      : undefined,
    timeoutMs: opts.timeoutMs,
    backup,
    dryRun: opts.dryRun,
    previousEnabled,
    existingOtherHooks: existingHooks,
    disabledBy,
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
  // Only the zcode family sets hooks.enabled; command-string agents (workbuddy,
  // claude) never touch the flag, so the warning below does not apply to them.
  if (!usesCommandString && previousEnabled !== true && existingHooks > 0) {
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
  if (disabledBy.length) {
    console.log("");
    console.log("Warning: Claude Code will not run this hook while these settings disable hooks:");
    for (const item of disabledBy) console.log("  " + item.flag + " in " + item.file);
  }
  if (opts.agent === "claude" && opts.scope === "workspace") {
    console.log("");
    console.log("Note: project-level Claude Code hooks require workspace trust (approve the");
    console.log("project or confirm under /hooks). The hook went to settings.local.json;");
    console.log("use --config .claude/settings.json only if you intend to commit it.");
  }
  console.log("");
  console.log("Note: each turn this hook stages all workspace changes (git add -A) and commits with --no-verify.");
  console.log("Start a new session (or reopen the workspace) for the hook to take effect.");
  console.log("Scope or undo, type in the agent's dialog box: 项目级别启用 hook / 禁用 hook");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
