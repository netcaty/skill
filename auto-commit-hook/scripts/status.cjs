"use strict";

const lib = require("./lib.cjs");

function inspect(opts, scope) {
  const local = Object.assign({}, opts, { scope, config: "" });
  const project = lib.projectDir(local);
  const cfgPath = lib.configPath(local);
  const installScript = lib.installScript(opts.agent);
  let parsed;
  try {
    parsed = lib.readConfig(cfgPath);
  } catch (err) {
    return { agent: opts.agent, scope, project, configPath: cfgPath, error: err.message };
  }
  const data = parsed.data;
  const hook = lib.findOurHook(data);
  const count = lib.countOurHooks(data);
  const enabled = !!(data.hooks && typeof data.hooks === "object" && data.hooks.enabled === true);
  const git = lib.gitCheck(project);
  // WorkBuddy hooks carry the bash path inside the command string.
  const commandBash = hook && hook.type === "command"
    ? (/^"([^"]+)"/.exec(hook.command || "") || [])[1]
    : "";
  const bash = hook && hook.type === "process" ? hook.command : commandBash;
  return {
    agent: opts.agent,
    scope,
    project,
    configPath: cfgPath,
    configExists: parsed.exists,
    installed: count > 0,
    enabled,
    hookCount: count,
    hook: lib.hookSummary(hook),
    installDir: lib.installDir(opts.agent),
    installScript,
    installExists: lib.isFile(installScript),
    bash,
    bashExists: bash ? lib.isFile(bash) : false,
    git
  };
}

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node status.cjs [options]",
      "",
      "Options:",
      "  --agent zcode|workbuddy  Target agent's config format (default: zcode)",
      "  --scope workspace|user   Config scope (default: user)",
      "  --project <dir>          Workspace root (default: CODEBUDDY_PROJECT_DIR /",
      "                           CLAUDE_PROJECT_DIR / ZCODE_PROJECT_DIR / cwd)",
      "  --all                    Show user and workspace scopes",
      "  --json                   Machine-readable result"
    ].join("\n"));
    return;
  }

  const results = opts.all
    ? [inspect(opts, "workspace"), inspect(opts, "user")]
    : [inspect(opts, opts.scope)];

  if (opts.json) {
    console.log(JSON.stringify(opts.all ? results : results[0], null, 2));
    return;
  }

  for (const result of results) {
    if (result.error) {
      console.log(result.agent + " " + result.scope + ": error - " + result.error);
      process.exitCode = 1;
      continue;
    }
    console.log(result.agent + " " + result.scope + ": " +
      (result.installed ? "installed" : "not installed"));
    console.log("  config : " + result.configPath + (result.configExists ? "" : " (missing)"));
    if (result.installed) {
      console.log("  enabled: " + (result.hook && result.hook.type === "command"
        ? "(n/a for workbuddy command hooks)"
        : result.enabled));
      if (result.hook && result.hook.type === "process") {
        console.log("  hook   : " + result.hook.command + " " + JSON.stringify(result.hook.args));
        console.log("  timeout: " + (result.hook.timeoutMs || "default") + " ms");
      } else if (result.hook) {
        console.log("  hook   : " + result.hook.command);
        console.log("  timeout: " + (result.hook.timeout || "default") + " s");
      }
      if (!result.bashExists) {
        console.log("  warning: the configured bash executable is missing");
      }
    }
    console.log("  scripts: " + (result.installExists ? "present" : "missing") +
      " (" + result.installDir + ")");
    console.log("  git    : " + (result.git.ok ? "ok" : "not available - " + result.git.detail.split(/\r?\n/)[0]));
    if (!result.git.ok) {
      console.log("           fix: git config --global --add safe.directory " +
        result.project.replace(/\\/g, "/"));
    }
  }

  const installed = results.filter(result => result.installed);
  if (installed.length > 1) {
    console.log("");
    console.log("Warning: the hook is installed in both scopes; every turn will commit twice.");
  }
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
