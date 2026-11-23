"use strict";

const path = require("path");
const lib = require("./lib.cjs");

// Default: report installation state only (installed/enabled/hook/scripts/last
// run). Two opt-in extensions keep the other concerns separate:
//   --doctor  environment blockers — bash path, Claude disable flags, git
//             availability/ownership, both scopes installed
//   --update  drift between the source checkout, the staged skill directory and
//             the copied hook assets
function inspect(opts, scope, doctor) {
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
  // WorkBuddy/Claude hooks carry the bash path inside the command string.
  const commandBash = hook && hook.type === "command"
    ? (/^"([^"]+)"/.exec(hook.command || "") || [])[1]
    : "";
  const bash = hook && hook.type === "process" ? hook.command : commandBash;
  const result = {
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
    lastRun: lib.readLastRun(opts.agent)
  };
  if (doctor) {
    // Claude Code merges user/project/local settings; a disable switch in any
    // of them silently stops the hook from running.
    result.disabledBy = opts.agent === "claude" ? lib.claudeDisableFlags(project) : [];
    result.git = lib.gitCheck(project);
  }
  return result;
}

// Update check: is the staged skill directory (~/.agents/skills/...) behind
// the source checkout, and are the agent's hook assets behind this skill
// directory? The source defaults to --source, then AUTOCOMMIT_SOURCE_DIR,
// then the .source.json install.sh writes; without any of those it falls back
// to this script's own skill directory (the checkout, when run from one).
function updateInfo(opts) {
  const installedDir = lib.skillInstallDir();
  const source = lib.resolveSourceDir(opts.source);
  const srcDir = source ? path.join(source, "auto-commit-hook") : lib.SKILL_ROOT;
  const sameDir = (a, b) =>
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const info = { source, sourceDir: srcDir, skillDir: null, assets: null };
  if (!sameDir(srcDir, installedDir)) {
    info.skillDir = Object.assign({ dir: installedDir },
      lib.compareDirs(srcDir, installedDir));
  }
  info.assets = Object.assign({ dir: lib.installDir(opts.agent) },
    lib.compareDirs(lib.ASSET_DIR, lib.installDir(opts.agent), lib.ASSET_FILES));
  return info;
}

// "differing: a, b" / "missing in ..." summary of a compareDirs result.
function driftSummary(cmp, dstName) {
  const parts = [];
  if (cmp.differing.length) parts.push("differing: " + cmp.differing.join(", "));
  if (cmp.missingInSrc.length) parts.push("missing in source: " + cmp.missingInSrc.join(", "));
  if (cmp.missingInDst.length) parts.push("missing in " + dstName + ": " + cmp.missingInDst.join(", "));
  return parts.join("; ") || "content differs";
}

function printUpdate(update) {
  if (update.source) {
    console.log("  source     : " + update.sourceDir);
  } else {
    console.log("  source     : no local checkout recorded - pass --source <checkout>" +
      " or re-run install.sh");
  }
  if (update.skillDir) {
    const cmp = update.skillDir;
    if (cmp.same) {
      console.log("  skill dir  : up to date with the source");
    } else {
      console.log("  skill dir  : OUTDATED vs " + cmp.dir + " - " + driftSummary(cmp, "skill dir"));
      console.log("  fix        : run install.sh in the checkout (or re-run the curl" +
        " one-liner), then bash scripts/run.sh install");
    }
  } else if (update.source) {
    console.log("  skill dir  : this script runs from the source, nothing to compare");
  } else {
    console.log("  skill dir  : not compared (no source recorded)");
  }
  const cmp = update.assets;
  if (cmp.same) {
    console.log("  hook assets: up to date with the skill dir (" + cmp.dir + ")");
  } else {
    console.log("  hook assets: OUTDATED vs " + cmp.dir + " - " + driftSummary(cmp, "assets"));
    console.log("  fix        : bash scripts/run.sh install");
  }
}

// A missing git, a repository that is not a work tree, and a repository owned
// by another user all make the hook skip silently. Only the ownership case has
// the safe.directory remedy; the others are expected states, not defects.
function printGit(result) {
  const git = result.git;
  if (git.ok) {
    console.log("  git    : ok");
    return;
  }
  const detail = (git.detail || "git rev-parse failed").trim();
  console.log("  git    : not usable - " + detail.split(/\r?\n/)[0]);
  if (/dubious ownership/i.test(detail)) {
    console.log("           fix: git config --global --add safe.directory " +
      result.project.replace(/\\/g, "/"));
  } else if (/not a git repository/i.test(detail)) {
    console.log("           note: not a working tree; the hook skips turns here");
  }
}

function main() {
  // --update and --doctor are status-only switches; keep them out of the
  // shared parser so install/uninstall still reject them.
  const argv = process.argv.slice(2);
  const wantsUpdate = argv.includes("--update");
  const wantsDoctor = argv.includes("--doctor");
  const opts = lib.parseArgs(argv.filter(arg => arg !== "--update" && arg !== "--doctor"));
  if (opts.help) {
    console.log([
      "Usage: node status.cjs [options]",
      "",
      "Options:",
      "  --agent zcode|workbuddy|claude",
      "                           Target agent's config format (default: zcode)",
      "  --scope workspace|user   Config scope (default: user)",
      "  --project <dir>          Workspace root (default: CODEBUDDY_PROJECT_DIR /",
      "                           CLAUDE_PROJECT_DIR / ZCODE_PROJECT_DIR / cwd)",
      "  --all                    Show user and workspace scopes",
      "  --doctor                 Also check runtime blockers: bash path, Claude",
      "                           disable flags, git availability/ownership,",
      "                           duplicate scope installs",
      "  --update                 Also compare the staged skill directory and the",
      "                           copied hook assets with their source",
      "  --source <dir>           Skill checkout for --update (default:",
      "                           AUTOCOMMIT_SOURCE_DIR, then the .source.json",
      "                           install.sh writes, then this script's own dir)",
      "  --json                   Machine-readable result"
    ].join("\n"));
    return;
  }

  const results = opts.all
    ? [inspect(opts, "workspace", wantsDoctor), inspect(opts, "user", wantsDoctor)]
    : [inspect(opts, opts.scope, wantsDoctor)];

  if (wantsUpdate) {
    const update = updateInfo(opts);
    for (const result of results) result.update = update;
  }

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
        ? "(n/a for command hooks)"
        : result.enabled));
      if (result.hook && result.hook.type === "process") {
        console.log("  hook   : " + result.hook.command + " " + JSON.stringify(result.hook.args));
        console.log("  timeout: " + (result.hook.timeoutMs || "default") + " ms");
      } else if (result.hook) {
        console.log("  hook   : " + result.hook.command);
        console.log("  timeout: " + (result.hook.timeout || "default") + " s");
      }
    }
    console.log("  scripts: " + (result.installExists ? "present" : "missing") +
      " (" + result.installDir + ")");
    if (result.lastRun && result.lastRun.status === "error") {
      console.log("  last run: FAILED " + (result.lastRun.at || "?") +
        " (" + (result.lastRun.stage || "?") + ") " +
        (result.lastRun.detail || ""));
      console.log("  log    : " + path.join(result.installDir, "auto-commit.log"));
    } else if (result.lastRun) {
      console.log("  last run: ok " + (result.lastRun.at || ""));
    }
    if (wantsDoctor) {
      if (!result.bashExists) {
        console.log("  warning: the configured bash executable is missing");
      }
      for (const item of result.disabledBy || []) {
        console.log("  warning: Claude Code ignores this hook while " +
          item.flag + " is set in " + item.file);
      }
      printGit(result);
    }
  }

  if (wantsUpdate) {
    console.log("");
    printUpdate(results[0].update);
  }

  if (wantsDoctor) {
    const installed = results.filter(result => result.installed);
    if (installed.length > 1) {
      console.log("");
      console.log("Warning: the hook is installed in both scopes; every turn will commit twice.");
    }
  }
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
