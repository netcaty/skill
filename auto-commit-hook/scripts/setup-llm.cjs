#!/usr/bin/env node
// Save/show/clear a manual LLM endpoint for the auto-commit message helper.
//
// Stored at ~/.agents/skills/auto-commit-hook/llm-config.json (test override:
// AUTOCOMMIT_LLM_CONFIG). At runtime the helper prefers this saved config over
// the session-derived providers (WorkBuddy loopback proxy / ZCode provider
// config); AUTOCOMMIT_LLM_URL/_KEY/_MODEL env overrides still win on top of it.
// The request style (anthropic /v1/messages vs openai /v1/chat/completions) is
// derived from the URL shape, so the same file serves either API.
//
//   node setup-llm.cjs --url <llm-url> --key <api-key> [--model <id[,id...]>] [--json]
//   node setup-llm.cjs --show    print the saved config with the key masked
//   node setup-llm.cjs --clear   remove the saved config
//   node setup-llm.cjs --help
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function configFile() {
  return process.env.AUTOCOMMIT_LLM_CONFIG ||
    path.join(os.homedir(), ".agents", "skills", "auto-commit-hook", "llm-config.json");
}

function parseArgs(argv) {
  const opts = { url: "", key: "", model: "", show: false, clear: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      if (i + 1 >= argv.length) throw new Error(arg + " requires a value");
      return argv[++i];
    };
    switch (arg) {
      case "--url": opts.url = take(); break;
      case "--key": opts.key = take(); break;
      case "--model": opts.model = take(); break;
      case "--show": opts.show = true; break;
      case "--clear": opts.clear = true; break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error("Unknown option: " + arg);
    }
  }
  if (opts.clear && (opts.url || opts.key || opts.model || opts.show)) {
    throw new Error("--clear cannot be combined with other options");
  }
  if (opts.show && (opts.url || opts.key || opts.model)) {
    throw new Error("--show cannot be combined with --url/--key/--model");
  }
  if (!opts.clear && !opts.show) {
    if (!opts.url) throw new Error("--url is required (or use --show / --clear / --help)");
    if (!opts.key) throw new Error("--key is required (or use --show / --clear / --help)");
  }
  return opts;
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "***";
  return key.slice(0, 3) + "…" + key.slice(-3);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return null; }
}

function show(cfg, opts) {
  const file = configFile();
  if (!cfg || (!cfg.url && !cfg.key)) {
    console.log("No manual LLM config saved (" + file + ").");
    return;
  }
  const models = (Array.isArray(cfg.model) ? cfg.model : String(cfg.model || "").split(","))
    .map(s => String(s).trim()).filter(Boolean).join(", ");
  if (opts.json) {
    console.log(JSON.stringify({ file, url: cfg.url || "", key: maskKey(cfg.key), model: models }));
    return;
  }
  console.log("file : " + file);
  console.log("url  : " + (cfg.url || ""));
  console.log("key  : " + maskKey(cfg.key));
  console.log("model: " + models);
}

function save(opts) {
  const cfg = {
    url: String(opts.url).trim(),
    key: String(opts.key).trim(),
    model: String(opts.model || "").split(",").map(s => s.trim()).filter(Boolean),
    savedAt: new Date().toISOString()
  };
  if (!cfg.url || !cfg.key) throw new Error("--url and --key must not be empty");
  if (!cfg.model.length) {
    console.log("Warning: no --model given; the provider must accept a default model.");
  }
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(file, { force: true }); } catch {}
    fs.renameSync(tmp, file);
  }
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  return cfg;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node setup-llm.cjs [options]",
      "",
      "Save the LLM endpoint the auto-commit hook uses for commit messages:",
      "  --url <llm-url>        full endpoint URL, anthropic (/v1/messages) or",
      "                         openai (/v1/chat/completions) style",
      "  --key <api-key>        API key (stored in llm-config.json, chmod 600 on unix)",
      "  --model <id[,id...]>   candidate model id(s), tried in order",
      "  --show [--json]        print the saved config (key masked)",
      "  --clear                remove the saved config"
    ].join("\n"));
    return;
  }
  if (opts.clear) {
    const file = configFile();
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log("Cleared " + file);
    } else {
      console.log("No manual LLM config to clear (" + file + ").");
    }
    return;
  }
  if (opts.show) {
    show(readConfig(), opts);
    return;
  }
  const cfg = save(opts);
  console.log("Saved manual LLM config:");
  console.log("  file : " + configFile());
  console.log("  url  : " + cfg.url);
  console.log("  key  : " + maskKey(cfg.key));
  console.log("  model: " + (cfg.model.join(", ") || "(none)"));
  console.log("The hook prefers this config over the session provider at runtime.");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
