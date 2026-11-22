"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SKILL_ROOT = path.resolve(__dirname, "..");
const ASSET_DIR = path.join(SKILL_ROOT, "hooks");
const SCRIPT_NAME = "auto-commit.sh";
const HELPER_NAME = "auto-commit-msg.cjs";
const DEFAULT_TIMEOUT_MS = 30000;
const AGENTS = ["zcode", "workbuddy", "claude"];

// Each agent gets its own asset copy, so uninstalling one never breaks the
// others on a machine that runs several of them.
function installDir(agent) {
  if (agent === "workbuddy") return path.join(os.homedir(), ".workbuddy", "hooks", "auto-commit");
  if (agent === "claude") return path.join(os.homedir(), ".claude", "hooks", "auto-commit");
  return path.join(os.homedir(), ".zcode", "hooks", "auto-commit");
}
function installScript(agent) { return path.join(installDir(agent), SCRIPT_NAME); }
function installHelper(agent) { return path.join(installDir(agent), HELPER_NAME); }
function stateFile(agent) { return path.join(installDir(agent), "install-state.json"); }
// Kept for compatibility with the zcode default.
const INSTALL_DIR = installDir("zcode");
const INSTALL_SCRIPT = installScript("zcode");
const INSTALL_HELPER = installHelper("zcode");
const STATE_FILE = stateFile("zcode");

// Same env-prefix detection the hook script uses at runtime: the installer
// typically runs inside an agent session, which advertises its host the same
// way. Brand-specific prefixes come before the shared pair: WorkBuddy also
// exports the CODEBUDDY_*/CLAUDE_* variables and ZCode exports a CLAUDE_* pair
// too, so only Claude Code's own markers (CLAUDECODE etc.) may select claude.
// A plain shell resolves to the zcode default.
function detectAgent() {
  if (/\bworkbuddy\b/i.test(process.env.WORKBUDDY_PRODUCT_NAME || "") ||
      process.env.WORKBUDDY_APP_NAME ||
      process.env.WORKBUDDY_APP_PATH ||
      process.env.WORKBUDDY_IS_PACKAGED ||
      process.env.WB_SHT_INSTDIR ||
      process.env.WORKBUDDY_NODE_FALLBACK_EXEC_PATH ||
      process.env.WORKBUDDY_WINDOWS_APP_INSTALL_DIR ||
      process.env.WORKBUDDY_APP_INSTALL_DIR ||
      process.env.WORKBUDDY_PROJECT_DIR) {
    return "workbuddy";
  }
  if (process.env.ZCODE_PROJECT_DIR ||
      process.env.ZCODE_SESSION_ID ||
      process.env.ZCODE_NODE_FALLBACK_EXEC_PATH ||
      process.env.ZCODE_WINDOWS_APP_INSTALL_DIR) {
    return "zcode";
  }
  if (process.env.CLAUDECODE ||
      process.env.CLAUDE_CODE_ENTRYPOINT ||
      process.env.CLAUDE_CODE_SSE_PORT) {
    return "claude";
  }
  return "zcode";
}

function parseArgs(argv) {
  const opts = {
    scope: "user",
    agent: "",
    agentSource: "",
    project: "",
    config: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    purge: false,
    dryRun: false,
    force: false,
    json: false,
    all: false,
    help: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(arg + " requires a value");
      return argv[++i];
    };
    switch (arg) {
      case "--scope":
        opts.scope = take();
        break;
      case "--agent":
        opts.agent = take();
        break;
      case "--project":
        opts.project = take();
        break;
      case "--config":
        opts.config = take();
        break;
      case "--timeout":
        opts.timeoutMs = Number(take());
        break;
      case "--purge":
        opts.purge = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error("Unknown option: " + arg);
    }
  }
  if (opts.scope !== "workspace" && opts.scope !== "user") {
    throw new Error("--scope must be workspace or user");
  }
  if (!opts.agent) {
    opts.agent = detectAgent();
    opts.agentSource = "detected";
  } else {
    opts.agentSource = "flag";
  }
  if (!AGENTS.includes(opts.agent)) {
    throw new Error("--agent must be one of: " + AGENTS.join(", "));
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) {
    throw new Error("--timeout must be at least 1000 ms");
  }
  return opts;
}

function projectDir(opts) {
  return path.resolve(opts.project || process.env.CODEBUDDY_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR || process.env.ZCODE_PROJECT_DIR || process.cwd());
}

// WorkBuddy's CLI home is fixed at ~/.workbuddy; the settings.json name
// follows the verified project-level layout. No env-var lookup.
function workbuddyHome() {
  return path.join(os.homedir(), ".workbuddy");
}

function configPath(opts) {
  if (opts.config) return path.resolve(opts.config);
  if (opts.agent === "workbuddy") {
    return opts.scope === "user"
      ? path.join(workbuddyHome(), "settings.json")
      : path.join(projectDir(opts), ".workbuddy", "settings.json");
  }
  if (opts.agent === "claude") {
    // Claude Code's documented settings layout: shared user settings and
    // per-project settings.json under .claude/.
    return opts.scope === "user"
      ? path.join(os.homedir(), ".claude", "settings.json")
      : path.join(projectDir(opts), ".claude", "settings.json");
  }
  return opts.scope === "user"
    ? path.join(os.homedir(), ".zcode", "cli", "config.json")
    : path.join(projectDir(opts), ".zcode", "config.json");
}

function otherConfigPath(opts) {
  if (opts.config) return "";
  return configPath(Object.assign({}, opts, {
    scope: opts.scope === "user" ? "workspace" : "user"
  }));
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { exists: false, data: {} };
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!raw.trim()) return { exists: true, data: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error("Cannot parse " + file + ": " + err.message);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(file + " must contain a JSON object");
  }
  return { exists: true, data };
}

function writeConfig(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = "";
  if (fs.existsSync(file)) {
    backup = file + ".zcode-auto-commit.bak";
    fs.copyFileSync(file, backup);
  }
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(file, { force: true }); } catch {}
    fs.renameSync(tmp, file);
  }
  return backup;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function previousEnabledValue(config) {
  const hooks = config && config.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "missing";
  return Object.prototype.hasOwnProperty.call(hooks, "enabled") ? hooks.enabled : "missing";
}

function isOurHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  if (hook.type === "process") {
    const args = Array.isArray(hook.args) ? hook.args : [];
    return args.some(a => typeof a === "string" && /(^|[\\/])auto-commit\.sh$/i.test(a));
  }
  if (hook.type === "command") {
    return typeof hook.command === "string" && /auto-commit\.sh/i.test(hook.command);
  }
  return false;
}

// The two hosts lay hooks out differently: ZCode nests them under
// hooks.events.<Event>[], WorkBuddy hangs arrays directly off hooks.<Event>[]
// (both verified against real configs). Iterate both uniformly.
function eventArrays(hooks) {
  const out = [];
  if (!hooks || typeof hooks !== "object") return out;
  const container = hooks.events && typeof hooks.events === "object" ? hooks.events : hooks;
  for (const [event, groups] of Object.entries(container)) {
    if (!Array.isArray(groups)) continue;
    out.push({ event, groups, container });
  }
  return out;
}

function eachHook(config, fn) {
  for (const { event, groups } of eventArrays(config && config.hooks)) {
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) fn(hook, event, group);
    }
  }
}

function countOurHooks(config) {
  let count = 0;
  eachHook(config, hook => { if (isOurHook(hook)) count++; });
  return count;
}

function countAllHooks(config) {
  let count = 0;
  eachHook(config, () => { count++; });
  return count;
}

function findOurHook(config) {
  let found = null;
  eachHook(config, hook => { if (!found && isOurHook(hook)) found = hook; });
  return found;
}

function stripOurHooks(hooks) {
  let removed = 0;
  for (const { event, groups, container } of eventArrays(hooks)) {
    const kept = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const next = group.hooks.filter(hook => {
        if (isOurHook(hook)) { removed++; return false; }
        return true;
      });
      if (next.length) kept.push(Object.assign({}, group, { hooks: next }));
    }
    if (kept.length) container[event] = kept;
    else delete container[event];
  }
  // Drop the events wrapper when the last zcode event array is gone.
  if (hooks && hooks.events && typeof hooks.events === "object" &&
      Object.keys(hooks.events).length === 0) {
    delete hooks.events;
  }
  return removed;
}

function ensureStopHook(config, bash, script, timeoutMs, agent) {
  if (config.hooks !== undefined &&
      (config.hooks === null || typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
    throw new Error("Existing 'hooks' value is not a JSON object; refusing to modify it");
  }
  if (!config.hooks) config.hooks = {};
  const hooks = config.hooks;
  stripOurHooks(hooks);

  if (agent === "workbuddy") {
    // No hooks.enabled and no events layer in the WorkBuddy layout; the
    // timeout unit is whole seconds.
    if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) {
      throw new Error("Existing 'hooks.Stop' value is not an array; refusing to modify it");
    }
    if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
    hooks.Stop.push({
      hooks: [{
        type: "command",
        command: hookCommandWorkbuddy(bash, script),
        timeout: Math.max(1, Math.round(timeoutMs / 1000))
      }]
    });
    return hooks;
  }

  if (agent === "claude") {
    // Claude Code settings.json uses the same flat hooks.Stop[] + quoted
    // command-string family as WorkBuddy, plus a per-group matcher (unused
    // for Stop but part of the documented schema) and whole-second timeout;
    // there is no hooks.enabled flag.
    if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) {
      throw new Error("Existing 'hooks.Stop' value is not an array; refusing to modify it");
    }
    if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
    hooks.Stop.push({
      matcher: "",
      hooks: [{
        type: "command",
        command: hookCommandWorkbuddy(bash, script),
        timeout: Math.max(1, Math.round(timeoutMs / 1000))
      }]
    });
    return hooks;
  }

  if (hooks.events !== undefined &&
      (hooks.events === null || typeof hooks.events !== "object" || Array.isArray(hooks.events))) {
    throw new Error("Existing 'hooks.events' value is not a JSON object; refusing to modify it");
  }
  if (!hooks.events) hooks.events = {};
  const events = hooks.events;
  if (events.Stop !== undefined && !Array.isArray(events.Stop)) {
    throw new Error("Existing 'hooks.events.Stop' value is not an array; refusing to modify it");
  }
  // stripOurHooks drops empty event arrays; re-create Stop before appending.
  if (!Array.isArray(events.Stop)) events.Stop = [];
  events.Stop.push({
    hooks: [{
      type: "process",
      command: bash,
      args: [script],
      timeoutMs: timeoutMs,
      statusMessage: "Auto-commit checkpoint"
    }]
  });
  hooks.enabled = true;
  return hooks;
}

function winSlashPath(p) {
  return path.resolve(p).replace(/\\/g, "/");
}

// Command-string hook agents (workbuddy, claude) take a single shell string
// with quoted, forward-slash paths (verified against a real
// .workbuddy/settings.json entry).
function hookCommandWorkbuddy(bash, script) {
  return '"' + winSlashPath(bash) + '" "' + winSlashPath(script) + '"';
}

function findBash(agent) {
  // Prefer the bash WorkBuddy itself ships; it is always present where the
  // WorkBuddy scope can be installed.
  if (agent === "workbuddy") {
    const bundled = process.env.CODEBUDDY_CODE_GIT_BASH_PATH;
    if (bundled && isFile(bundled)) return path.resolve(bundled);
  }
  const explicit = process.env.AUTOCOMMIT_BASH;
  if (explicit && isFile(explicit)) return path.resolve(explicit);
  if (process.platform !== "win32") {
    for (const p of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"]) {
      if (isFile(p)) return p;
    }
    try {
      const out = execFileSync("bash", ["-c", "command -v bash"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
      });
      const p = out.trim().split(/\r?\n/)[0];
      if (p && isFile(p)) return p;
    } catch {}
    return "";
  }

  const candidates = [];
  const pf = process.env.ProgramFiles;
  const pfx86 = process.env["ProgramFiles(x86)"];
  const local = process.env.LOCALAPPDATA;
  const home = process.env.USERPROFILE || os.homedir();
  if (pf) {
    candidates.push(path.join(pf, "Git", "bin", "bash.exe"));
    candidates.push(path.join(pf, "Git", "usr", "bin", "bash.exe"));
  }
  if (pfx86) {
    candidates.push(path.join(pfx86, "Git", "bin", "bash.exe"));
    candidates.push(path.join(pfx86, "Git", "usr", "bin", "bash.exe"));
  }
  if (local) {
    candidates.push(path.join(local, "Programs", "Git", "bin", "bash.exe"));
    candidates.push(path.join(local, "Programs", "Git", "usr", "bin", "bash.exe"));
  }
  if (home) {
    candidates.push(path.join(home, "scoop", "apps", "git", "current", "usr", "bin", "bash.exe"));
    candidates.push(path.join(home, "scoop", "apps", "git", "current", "bin", "bash.exe"));
    candidates.push(path.join(home, "scoop", "shims", "bash.exe"));
  }
  for (const p of candidates) {
    if (isFile(p)) return p;
  }
  try {
    const out = execFileSync("where.exe", ["bash.exe"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true
    });
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (!p || !isFile(p)) continue;
      // WSL's bash cannot run a Windows script path; skip it.
      if (/[\\/]Windows[\\/]System32[\\/]bash\.exe$/i.test(p)) continue;
      return p;
    }
  } catch {}
  return "";
}

function toPosixPath(p) {
  if (process.platform !== "win32") return p;
  const abs = path.resolve(p);
  if (abs.startsWith("\\\\")) return "//" + abs.slice(2).replace(/\\/g, "/");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(abs);
  if (!match) return abs.replace(/\\/g, "/");
  return "/" + match[1].toLowerCase() + "/" + match[2].replace(/\\/g, "/");
}

function installAssets(agent) {
  const dir = installDir(agent);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [SCRIPT_NAME, HELPER_NAME]) {
    const src = path.join(ASSET_DIR, name);
    if (!isFile(src)) throw new Error("Missing bundled asset: " + src);
    fs.copyFileSync(src, path.join(dir, name));
  }
  if (process.platform !== "win32") {
    for (const name of [SCRIPT_NAME, HELPER_NAME]) {
      try { fs.chmodSync(path.join(dir, name), 0o755); } catch {}
    }
  }
}

function readState(agent) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(agent), "utf8"));
    if (state && typeof state === "object" &&
        state.installs && typeof state.installs === "object") {
      return state;
    }
  } catch {}
  return { version: 1, installs: {} };
}

function writeState(state, agent) {
  fs.mkdirSync(installDir(agent), { recursive: true });
  fs.writeFileSync(stateFile(agent), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function recordInstall(configFile, previousEnabled, configExisted, agent) {
  const state = readState(agent);
  const key = path.resolve(configFile);
  if (!state.installs[key]) {
    state.installs[key] = {
      previousEnabled,
      configExisted,
      installedAt: new Date().toISOString()
    };
  } else {
    state.installs[key].installedAt = new Date().toISOString();
  }
  writeState(state, agent);
}

function takeInstallState(configFile, agent) {
  const state = readState(agent);
  const key = path.resolve(configFile);
  const entry = state.installs[key] || null;
  if (entry) delete state.installs[key];
  return { state, entry };
}

function installStatusIn(file) {
  if (!fs.existsSync(file)) return false;
  try {
    return countOurHooks(readConfig(file).data) > 0;
  } catch {
    return null;
  }
}

function gitCheck(project) {
  try {
    const out = execFileSync("git", ["-C", project, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
    return { ok: out.trim() === "true", detail: "" };
  } catch (err) {
    const detail = err && err.stderr
      ? String(err.stderr).trim()
      : (err && err.message ? err.message : "git rev-parse failed");
    return { ok: false, detail };
  }
}

function hookSummary(hook) {
  if (!hook) return null;
  return {
    type: hook.type,
    command: hook.command,
    args: hook.args,
    timeoutMs: hook.timeoutMs,
    timeout: hook.timeout,
    statusMessage: hook.statusMessage
  };
}

module.exports = {
  SKILL_ROOT,
  ASSET_DIR,
  AGENTS,
  INSTALL_DIR,
  INSTALL_SCRIPT,
  INSTALL_HELPER,
  STATE_FILE,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  detectAgent,
  projectDir,
  workbuddyHome,
  installDir,
  installScript,
  installHelper,
  stateFile,
  configPath,
  otherConfigPath,
  readConfig,
  writeConfig,
  isFile,
  previousEnabledValue,
  isOurHook,
  countOurHooks,
  countAllHooks,
  findOurHook,
  stripOurHooks,
  ensureStopHook,
  eventArrays,
  winSlashPath,
  hookCommandWorkbuddy,
  findBash,
  toPosixPath,
  installAssets,
  readState,
  writeState,
  recordInstall,
  takeInstallState,
  installStatusIn,
  gitCheck,
  hookSummary
};
