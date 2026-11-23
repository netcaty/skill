"use strict";

const fs = require("fs");
const path = require("path");
const lib = require("./lib.cjs");

function purgeIfUnused(opts, state) {
  if (!opts.purge || opts.dryRun) return false;
  // Only this agent's config files can reference this agent's asset copy.
  const configs = new Set();
  for (const scope of ["workspace", "user"]) {
    configs.add(lib.configPath(Object.assign({}, opts, { scope, config: "" })));
  }
  for (const key of Object.keys((state && state.installs) || {})) configs.add(key);

  let stillInstalled = false;
  let unknown = false;
  for (const file of configs) {
    const status = lib.installStatusIn(file);
    if (status === true) { stillInstalled = true; break; }
    if (status === null) unknown = true;
  }
  if (stillInstalled) return false;
  if (unknown) {
    console.error("Warning: a config file could not be parsed; leaving " +
      lib.installDir(opts.agent) + " in place. Remove it manually if no hook uses it.");
    return false;
  }
  // Remove the copied hook files but keep the backups/ directory: it holds
  // pre-install config snapshots that are deliberately outside the workspace.
  const dir = lib.installDir(opts.agent);
  for (const name of lib.ASSET_FILES) fs.rmSync(path.join(dir, name), { force: true });
  fs.rmSync(lib.stateFile(opts.agent), { force: true });
  try { fs.rmdirSync(dir); } catch {}  // succeeds only when backups/ is absent
  return true;
}

function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node uninstall.cjs [options]",
      "",
      "Options:",
      "  --agent zcode|workbuddy|claude",
      "                           Target agent's config format (default: zcode)",
      "  --scope workspace|user   Config scope (default: user)",
      "  --project <dir>          Workspace root (default: CODEBUDDY_PROJECT_DIR /",
      "                           CLAUDE_PROJECT_DIR / ZCODE_PROJECT_DIR / cwd)",
      "  --config <file>          Explicit hooks config path",
      "  --purge                  Remove installed scripts (keeps backups) when no",
      "                           config references them",
      "  --dry-run                Print the planned change without writing",
      "  --json                   Machine-readable result"
    ].join("\n"));
    return;
  }

  const cfgPath = lib.configPath(opts);
  const { exists, data } = lib.readConfig(cfgPath);
  if (!exists) {
    report(opts, {
      removed: 0,
      configPath: cfgPath,
      installed: false,
      purged: purgeIfUnused(opts, lib.readState(opts.agent)),
      dryRun: opts.dryRun
    });
    return;
  }

  const hooks = data.hooks;
  const removed = lib.stripOurHooks(hooks);
  if (!removed) {
    report(opts, {
      removed: 0,
      configPath: cfgPath,
      installed: false,
      purged: purgeIfUnused(opts, lib.readState(opts.agent)),
      dryRun: opts.dryRun
    });
    return;
  }

  const { state, entry } = lib.takeInstallState(cfgPath, opts.agent);
  if (entry) {
    if (entry.previousEnabled === "missing") delete hooks.enabled;
    else hooks.enabled = entry.previousEnabled;
  }
  if (hooks && typeof hooks === "object" && hooks.events &&
      typeof hooks.events === "object" && Object.keys(hooks.events).length === 0) {
    delete hooks.events;
  }
  if (hooks && typeof hooks === "object" && Object.keys(hooks).length === 0) {
    delete data.hooks;
  }

  let backup = "";
  if (!opts.dryRun) {
    const createdByUs = entry && entry.configExisted === false;
    if (createdByUs && Object.keys(data).length === 0) {
      fs.rmSync(cfgPath, { force: true });
    } else {
      backup = lib.writeConfig(cfgPath, data, opts.agent);
    }
    if (entry) lib.writeState(state, opts.agent);
  }

  report(opts, {
    removed,
    configPath: cfgPath,
    installed: true,
    backup,
    purged: purgeIfUnused(opts, state),
    dryRun: opts.dryRun,
    previousEnabled: entry ? entry.previousEnabled : null
  });
}

function report(opts, result) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!result.installed) {
    console.log("Auto-commit hook is not installed in " + result.configPath + ".");
    if (result.purged) {
      console.log("  purged : " + lib.installDir(opts.agent));
    } else if (opts.purge) {
      console.log("  " + (result.dryRun ? "would purge" : "kept") + " : " +
        lib.installDir(opts.agent) + " (still referenced or could not be verified)");
    }
    return;
  }
  console.log((result.dryRun ? "Would remove" : "Removed") + " " + result.removed +
    " auto-commit Stop hook entr" + (result.removed === 1 ? "y" : "ies") +
    " from " + result.configPath + ".");
  if (result.backup) console.log("  backup : " + result.backup);
  if (result.previousEnabled === "missing") {
    console.log("  hooks.enabled removed (it was not set before install)");
  } else if (result.previousEnabled !== null) {
    console.log("  hooks.enabled restored to: " + String(result.previousEnabled));
  }
  if (result.purged) {
    console.log("  purged : " + lib.installDir(opts.agent));
  } else if (opts.purge) {
    console.log("  kept   : " + lib.installDir(opts.agent) + " (still referenced or could not be verified)");
  }
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
