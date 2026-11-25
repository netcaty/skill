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
  const pause = lib.readPause(opts.agent);
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
    disabled: !!pause,
    disabledSince: pause && typeof pause.at === "string" ? pause.at : "",
    pauseFile: lib.pauseFile(opts.agent),
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
// gitProblem() keeps this classification identical to install's warning.
function printGit(result) {
  const git = result.git;
  if (git.ok) {
    console.log("  git    : ok");
    return;
  }
  const problem = lib.gitProblem(git.detail);
  console.log("  git    : not usable - " + problem.detail);
  if (problem.kind === "ownership") {
    console.log("           fix: git config --global --add safe.directory " +
      result.project.replace(/\\/g, "/"));
  } else if (problem.kind === "not-a-repo") {
    console.log("           note: not a working tree; the hook skips turns here");
  }
}

// The "ai" record written by the hook explains how the commit message was
// produced. "unavailable" and "error" are diagnostics, not failed commits:
// the top-level lastRun.status stays ok whenever the commit itself succeeded.
function oneLine(value, max) {
  const text = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

// The gate summary from the helper: which screen actually ran, how many paths
// it excluded, and whether anything was dropped because a reported path did
// not resolve against the staged list or the cap was hit.
function printSensitive(ai) {
  const s = ai && ai.sensitive;
  if (!s || typeof s !== "object") return;
  const parts = [s.screened === "model+local" ? "local+model" : "local only"];
  parts.push((Number(s.excluded) || 0) + " excluded");
  if (Number(s.unmatched)) parts.push(Number(s.unmatched) + " unmatched path(s)");
  if (s.truncated) parts.push("truncated at the exclusion cap");
  const screen = s.screen;
  if (screen && screen.status && screen.status !== "ok" && screen.status !== "pending") {
    parts.push("screen " + oneLine(screen.status, 20) +
      (screen.reason ? " (" + oneLine(screen.reason, 100) + ")" : ""));
  }
  console.log("  sensitive: " + parts.join(", "));
}

function printAi(ai) {
  if (!ai || typeof ai !== "object") return;
  const status = String(ai.status || "?");
  const detail = [];
  if (ai.source) detail.push(oneLine(ai.source, 40));
  else if (ai.agent) detail.push("agent " + oneLine(ai.agent, 40));
  if (ai.transport) detail.push(oneLine(ai.transport, 20));
  if (ai.model) detail.push(oneLine(ai.model, 60));
  if (typeof ai.ms === "number") detail.push(ai.ms + " ms");
  const suffix = detail.length ? " (" + detail.join(", ") + ")" : "";
  if (status === "ok") {
    console.log("  ai     : ok" + suffix);
    printSensitive(ai);
    return;
  }
  const label = status === "error" ? "FAILED" : status;
  const reason = ai.reason ? " - " + oneLine(ai.reason, 200) : "";
  console.log("  ai     : " + label + reason + suffix);
  printSensitive(ai);
  for (const item of (Array.isArray(ai.checked) ? ai.checked : []).slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    console.log("           " + (item.source ? oneLine(item.source, 40) + ": " : "") +
      oneLine(item.reason || "unavailable", 200));
  }
  if (status !== "error") return;
  for (const attempt of (Array.isArray(ai.attempts) ? ai.attempts : []).slice(0, 6)) {
    if (!attempt || typeof attempt !== "object") continue;
    const parts = [];
    if (attempt.model) parts.push(oneLine(attempt.model, 60) + ":");
    parts.push(oneLine(attempt.error || "ok", 200));
    if (typeof attempt.code === "number") parts.push("exit " + attempt.code);
    if (typeof attempt.ms === "number") parts.push("(" + attempt.ms + " ms)");
    console.log("           " + parts.join(" "));
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
    if (result.installed && result.disabled) {
      console.log("  disabled: yes" +
        (result.disabledSince ? " since " + result.disabledSince : "") +
        " - run.sh enable to resume");
    }
    if (result.lastRun && result.lastRun.status === "error") {
      console.log("  last run: FAILED " + (result.lastRun.at || "?") +
        " (" + (result.lastRun.stage || "?") + ") " +
        (result.lastRun.detail || ""));
      console.log("  log    : " + path.join(result.installDir, "auto-commit.log"));
    } else if (result.lastRun) {
      console.log("  last run: ok " + (result.lastRun.at || ""));
    }
    if (result.lastRun) printAi(result.lastRun.ai);
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
