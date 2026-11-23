"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const SKILL_ROOT = path.resolve(__dirname, "..");
const ASSET_DIR = path.join(SKILL_ROOT, "hooks");
const SCRIPT_NAME = "auto-commit.sh";
const HELPER_NAME = "auto-commit-msg.cjs";
const DEFAULT_TIMEOUT_MS = 30000;

// The two hook files install.cjs copies to the agent's asset directory. The
// bundler/checkout side of the pair is ASSET_DIR.
const ASSET_FILES = [SCRIPT_NAME, HELPER_NAME];

// ---------------------------------------------------------------------------
// Agent registry — the authoritative install-side facts per supported agent.
// detectAgent() picks a profile and every install-side feature (asset dir,
// hook config location, hook JSON schema) goes through it. Adding an agent
// (e.g. dsh) means adding one defineAgent() entry here; only when its hook
// format or commit-message model source is genuinely new does it also need a
// HOOK_SCHEMA_WRITERS entry (below) / a MODEL_SOURCES entry in
// hooks/auto-commit-msg.cjs plus an optional marker line in the detection
// table of hooks/auto-commit.sh.
//
// priority is the detection order: brand-specific prefixes must win over
// shared ones (WorkBuddy exports the CODEBUDDY_*/CLAUDE_* pair and ZCode
// exports a CLAUDE_* pair too), so workbuddy (10) < zcode (20) < claude (30).
// A plain shell matches no profile and falls back to FALLBACK_AGENT.
// ---------------------------------------------------------------------------

const FALLBACK_AGENT = "zcode";

function defineAgent(profile) {
  return Object.freeze(Object.assign({ priority: 1000 }, profile));
}

const AGENT_PROFILES = {
  zcode: defineAgent({
    name: "zcode",
    priority: 20,
    detect(env) {
      return !!(env.ZCODE_PROJECT_DIR || env.ZCODE_SESSION_ID ||
        env.ZCODE_NODE_FALLBACK_EXEC_PATH || env.ZCODE_WINDOWS_APP_INSTALL_DIR);
    },
    installDir(home) {
      return path.join(home, ".zcode", "hooks", "auto-commit");
    },
    configPaths(project, home) {
      return {
        workspace: path.join(project, ".zcode", "config.json"),
        user: path.join(home, ".zcode", "cli", "config.json")
      };
    },
    hookSchema: "process-events"
  }),
  workbuddy: defineAgent({
    name: "workbuddy",
    priority: 10,
    detect(env) {
      return /\bworkbuddy\b/i.test(env.WORKBUDDY_PRODUCT_NAME || "") ||
        !!(env.WORKBUDDY_APP_NAME || env.WORKBUDDY_APP_PATH ||
          env.WORKBUDDY_IS_PACKAGED || env.WB_SHT_INSTDIR ||
          env.WORKBUDDY_NODE_FALLBACK_EXEC_PATH ||
          env.WORKBUDDY_WINDOWS_APP_INSTALL_DIR ||
          env.WORKBUDDY_APP_INSTALL_DIR || env.WORKBUDDY_PROJECT_DIR);
    },
    installDir(home) {
      return path.join(home, ".workbuddy", "hooks", "auto-commit");
    },
    // WorkBuddy's CLI home is fixed at ~/.workbuddy; the settings.json name
    // follows the verified project-level layout. No env-var lookup.
    configPaths(project, home) {
      return {
        workspace: path.join(project, ".workbuddy", "settings.json"),
        user: path.join(home, ".workbuddy", "settings.json")
      };
    },
    hookSchema: "command-flat"
  }),
  claude: defineAgent({
    name: "claude",
    priority: 30,
    // Only Claude Code's own markers may select claude, and this profile is
    // deliberately checked after zcode's: ZCode exports a CLAUDE_* pair too.
    detect(env) {
      return !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SSE_PORT);
    },
    installDir(home) {
      return path.join(home, ".claude", "hooks", "auto-commit");
    },
    // Claude Code merges user settings with both project files. The hook
    // command embeds this machine's bash path, so the project scope targets
    // settings.local.json (personal, normally gitignored); settings.json is
    // team-shared and would be committed with a path that breaks teammates.
    configPaths(project, home) {
      return {
        workspace: path.join(project, ".claude", "settings.local.json"),
        user: path.join(home, ".claude", "settings.json")
      };
    },
    hookSchema: "command-flat-claude"
  })
};

const AGENTS = Object.keys(AGENT_PROFILES);

function getAgentProfile(agent) {
  return AGENT_PROFILES[agent] || null;
}

// Each agent gets its own asset copy, so uninstalling one never breaks the
// others on a machine that runs several of them. Unknown agents fall back to
// the zcode copy, matching the pre-registry behavior (parseArgs rejects them
// at the CLI level anyway).
function installDir(agent) {
  const profile = getAgentProfile(agent) || AGENT_PROFILES[FALLBACK_AGENT];
  return profile.installDir(os.homedir());
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
// way. Profiles are consulted in priority order (see AGENT_PROFILES); a plain
// shell matches none and falls back to FALLBACK_AGENT, preserving the
// historical zcode default.
function detectAgent() {
  const profiles = Object.values(AGENT_PROFILES).sort((a, b) => a.priority - b.priority);
  for (const profile of profiles) {
    if (profile.detect(process.env)) return profile.name;
  }
  return FALLBACK_AGENT;
}

function parseArgs(argv) {
  const opts = {
    scope: "user",
    agent: "",
    agentSource: "",
    project: "",
    config: "",
    source: "",
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
      case "--source":
        opts.source = take();
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
  const profile = getAgentProfile(opts.agent) || AGENT_PROFILES[FALLBACK_AGENT];
  const paths = profile.configPaths(projectDir(opts), os.homedir());
  return opts.scope === "user" ? paths.user : paths.workspace;
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

// Config backups live under the agent's asset directory, never next to the
// config: a workspace config may be gitignored while its `.bak` sibling is
// not, and the hook's own `git add -A` would then commit a copy of local
// settings (which can contain tokens). The path hash keeps user, workspace
// and --config targets that share a basename apart.
function backupFile(file, agent) {
  const dir = path.join(installDir(agent), "backups");
  const hash = crypto.createHash("sha1").update(path.resolve(file)).digest("hex").slice(0, 8);
  return path.join(dir, path.basename(file) + "." + hash + ".zcode-auto-commit.bak");
}

function writeConfig(file, data, agent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = "";
  if (fs.existsSync(file)) {
    backup = backupFile(file, agent);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
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

// Claude Code merges hooks from user settings, project settings.json and
// project settings.local.json; disableAllHooks / allowManagedHooksOnly in any
// of them stops a registered Stop hook from running. Best-effort: a managed
// policy file cannot be read from here.
function claudeSettingsFiles(project) {
  const home = os.homedir();
  return [
    path.join(home, ".claude", "settings.json"),
    path.join(project, ".claude", "settings.json"),
    path.join(project, ".claude", "settings.local.json")
  ];
}

function claudeDisableFlags(project) {
  const out = [];
  const seen = new Set();
  for (const file of claudeSettingsFiles(project)) {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const { data } = readConfig(file);
      if (data.disableAllHooks === true) out.push({ file, flag: "disableAllHooks" });
      if (data.allowManagedHooksOnly === true) out.push({ file, flag: "allowManagedHooksOnly" });
    } catch {}
  }
  return out;
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

// Hook JSON schema writers, keyed by AGENT_PROFILES[...].hookSchema. A new
// agent needs an entry here only when its hook layout is genuinely new; the
// prologue (hooks object validation + stripOurHooks) is shared below.
const HOOK_SCHEMA_WRITERS = {
  // WorkBuddy: flat hooks.Stop[] with a quoted command string; no
  // hooks.enabled and no events layer; whole-second timeout. (Verified
  // against a real .workbuddy/settings.json entry.)
  "command-flat"(hooks, bash, script, timeoutMs) {
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
  },
  // Claude Code uses the same command-string family; matcher is optional and
  // irrelevant for Stop (the verified probe config omits it), timeout is whole
  // seconds, and statusMessage is supported. No hooks.enabled here either.
  "command-flat-claude"(hooks, bash, script, timeoutMs) {
    if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) {
      throw new Error("Existing 'hooks.Stop' value is not an array; refusing to modify it");
    }
    if (!Array.isArray(hooks.Stop)) hooks.Stop = [];
    hooks.Stop.push({
      hooks: [{
        type: "command",
        command: hookCommandWorkbuddy(bash, script),
        timeout: Math.max(1, Math.round(timeoutMs / 1000)),
        statusMessage: "Auto-commit checkpoint"
      }]
    });
    return hooks;
  },
  // ZCode nests entries under hooks.events.<Event>[] as process argv and
  // requires hooks.enabled: true (required for configuration-file hooks; the
  // installer warns when it also enables other hooks in the file).
  "process-events"(hooks, bash, script, timeoutMs) {
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
};

function ensureStopHook(config, bash, script, timeoutMs, agent) {
  const profile = getAgentProfile(agent) || AGENT_PROFILES[FALLBACK_AGENT];
  const writer = HOOK_SCHEMA_WRITERS[profile.hookSchema];
  if (!writer) throw new Error("Unknown hook schema: " + profile.hookSchema);
  if (config.hooks !== undefined &&
      (config.hooks === null || typeof config.hooks !== "object" || Array.isArray(config.hooks))) {
    throw new Error("Existing 'hooks' value is not a JSON object; refusing to modify it");
  }
  if (!config.hooks) config.hooks = {};
  stripOurHooks(config.hooks);
  return writer(config.hooks, bash, script, timeoutMs);
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
  // Claude Code exports the bash it uses for hook commands (and points SHELL
  // at it in Git Bash mode); prefer that exact binary for the registration.
  if (agent === "claude") {
    for (const candidate of [process.env.CLAUDE_CODE_GIT_BASH_PATH, process.env.SHELL]) {
      if (candidate && /(^|[\\/])bash(\.exe)?$/i.test(candidate) && isFile(candidate)) {
        return path.resolve(candidate);
      }
    }
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

// ---------------------------------------------------------------------------
// Update detection — the skill lives in three places that go stale
// independently: this checkout/skill directory (SKILL_ROOT), the staged skill
// directory (~/.agents/skills/auto-commit-hook/, written by install.sh) and
// the agent's asset copy (installDir(), written by install.cjs). status.cjs
// hashes UPDATABLE_FILES across them and reports which pairs differ.
// ---------------------------------------------------------------------------

// Everything install.sh stages. Must stay in sync with the FILES list in the
// repository's install.sh.
const UPDATABLE_FILES = [
  "SKILL.md",
  "hooks/auto-commit.sh",
  "hooks/auto-commit-msg.cjs",
  "scripts/lib.cjs",
  "scripts/install.cjs",
  "scripts/uninstall.cjs",
  "scripts/status.cjs",
  "scripts/setup-llm.cjs"
];

// Where install.sh stages the skill directory (same default and env override
// as its SKILL_DIR).
function skillInstallDir() {
  return process.env.AUTOCOMMIT_INSTALL_DIR ||
    path.join(os.homedir(), ".agents", "skills", "auto-commit-hook");
}

function hashFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// Hash-compare `files` (default UPDATABLE_FILES) between two directories.
// Missing files are reported separately from differing content so a caller
// can tell an incomplete install from a stale one.
function compareDirs(srcDir, dstDir, files) {
  const result = { same: true, differing: [], missingInSrc: [], missingInDst: [] };
  for (const rel of files || UPDATABLE_FILES) {
    const srcHash = hashFile(path.join(srcDir, rel));
    const dstHash = hashFile(path.join(dstDir, rel));
    if (srcHash === null) { result.missingInSrc.push(rel); result.same = false; }
    else if (dstHash === null) { result.missingInDst.push(rel); result.same = false; }
    else if (srcHash !== dstHash) { result.differing.push(rel); result.same = false; }
  }
  return result;
}

// The local checkout to update from: --source flag, AUTOCOMMIT_SOURCE_DIR,
// then the .source.json install.sh writes (local mode only). Empty string
// when nothing records a checkout — the caller falls back to SKILL_ROOT or
// to install.sh's download mode.
function resolveSourceDir(flag) {
  if (flag) return path.resolve(flag);
  if (process.env.AUTOCOMMIT_SOURCE_DIR) {
    return path.resolve(process.env.AUTOCOMMIT_SOURCE_DIR);
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(skillInstallDir(), ".source.json"), "utf8"));
    if (meta && meta.mode === "local" && typeof meta.source === "string" &&
        isFile(path.join(meta.source, "auto-commit-hook", "SKILL.md"))) {
      return path.resolve(meta.source);
    }
  } catch {}
  return "";
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
  ASSET_FILES,
  AGENTS,
  AGENT_PROFILES,
  FALLBACK_AGENT,
  getAgentProfile,
  HOOK_SCHEMA_WRITERS,
  INSTALL_DIR,
  INSTALL_SCRIPT,
  INSTALL_HELPER,
  STATE_FILE,
  DEFAULT_TIMEOUT_MS,
  UPDATABLE_FILES,
  skillInstallDir,
  hashFile,
  compareDirs,
  resolveSourceDir,
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
  backupFile,
  isFile,
  previousEnabledValue,
  claudeSettingsFiles,
  claudeDisableFlags,
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
