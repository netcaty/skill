#!/usr/bin/env node
// Show, save, set, unset or clear the auto-commit hook's user configuration.
//
// Stored at ~/.agents/skills/auto-commit-hook/config.json (path override:
// AUTOCOMMIT_CONFIG, mainly for tests). The hook reads the file and never
// writes it; only this command writes. Priority is per key:
// environment variable > config.json > default/session provider.
//
// Flat schema: the manual endpoint is url/key/model (all three required
// together); noAi, claudeBin, aiTimeoutMs, aiTotalMs and sourceDir are runtime
// settings. A file with only settings keeps the host's session provider.
// The legacy llm-config.json is not read; --show warns when it still exists.
//
//   node config.cjs --url <llm-url> --key <api-key> [--model <id[,id...]>]
//   node config.cjs --set <key>=<value> [--set ...] [--unset <key> ...]
//   node config.cjs --show [--json]
//   node config.cjs --clear
//   node config.cjs --help
"use strict";

const fs = require("fs");
const lib = require("./lib.cjs");

function parseArgs(argv) {
  const opts = {
    url: "", key: "", model: "", sets: [], unsets: [],
    show: false, clear: false, json: false, help: false
  };
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
      case "--set": opts.sets.push(take()); break;
      case "--unset": opts.unsets.push(take().trim()); break;
      case "--show": opts.show = true; break;
      case "--clear": opts.clear = true; break;
      case "--json": opts.json = true; break;
      case "-h": case "--help": opts.help = true; break;
      default: throw new Error("Unknown option: " + arg);
    }
  }
  const writes = opts.url || opts.key || opts.model || opts.sets.length ||
    opts.unsets.length;
  if (opts.clear && (writes || opts.show)) {
    throw new Error("--clear cannot be combined with other options");
  }
  if (opts.show && writes) {
    throw new Error("--show cannot be combined with write options");
  }
  if ((opts.url || opts.key || opts.model) && (!opts.url || !opts.key)) {
    throw new Error("--url and --key are required together (or use --set/--show/--clear)");
  }
  if (!opts.clear && !opts.show && !opts.help && !writes) {
    throw new Error("nothing to do (use --url/--set/--unset, --show or --clear)");
  }
  return opts;
}

function parseAssignments(sets) {
  return sets.map(raw => {
    const at = raw.indexOf("=");
    if (at < 1) throw new Error("--set expects key=value, got: " + raw.split("=")[0]);
    return { key: raw.slice(0, at).trim(), value: raw.slice(at + 1) };
  });
}

function checkUnsets(unsets) {
  for (const key of unsets) {
    if (!lib.USER_CONFIG_KNOWN_KEYS.includes(key) || key === "savedAt") {
      throw new Error("Unknown config key: " + key);
    }
  }
}

function maskedView(data) {
  const out = { ...data };
  if (out.key !== undefined) out.key = lib.maskSecret(out.key);
  return out;
}

function save(opts) {
  const read = lib.readUserConfig();
  if (read.error) {
    throw new Error("refusing to overwrite invalid " + read.file + ": " + read.error +
      " (fix the file or run --clear)");
  }
  const data = { ...read.data };
  const warnings = [];
  const assignments = parseAssignments(opts.sets);
  const setKeys = new Set(assignments.map(item => item.key));
  for (const key of opts.unsets) {
    if (setKeys.has(key)) throw new Error(key + " is both set and unset");
  }
  checkUnsets(opts.unsets);

  if (opts.url || opts.key || opts.model) {
    const url = String(opts.url).trim();
    const key = String(opts.key).trim();
    if (!url || !key) throw new Error("--url and --key must not be empty");
    data.url = url;
    data.key = key;
    const models = lib.normalizeModels(opts.model);
    if (models.length) data.model = models;
    else if (opts.model) throw new Error("--model must not be empty");
    else if (data.model === undefined) {
      warnings.push("no --model given; the provider must accept a default model");
    }
  }

  for (const item of assignments) {
    data[item.key] = lib.validateConfigValue(item.key, item.value);
  }
  for (const key of opts.unsets) {
    if (!(key in data)) warnings.push("not set: " + key);
    delete data[key];
  }
  data.savedAt = new Date().toISOString();

  const partial = (data.url || data.key || data.model) &&
    !(data.url && data.key && lib.normalizeModels(data.model).length);
  if (partial) {
    warnings.push("incomplete manual endpoint (need url, key and model); " +
      "the session provider will be used");
  }

  lib.writeUserConfig(data);
  return { data, warnings };
}

function show(opts) {
  const info = lib.effectiveConfig();
  if (opts.json) {
    console.log(JSON.stringify({
      file: info.file,
      configPathSource: process.env.AUTOCOMMIT_CONFIG ? "AUTOCOMMIT_CONFIG" : "default",
      exists: info.exists,
      saved: maskedView(info.data),
      effective: {
        ...info.effective,
        key: { ...info.effective.key, value: lib.maskSecret(info.effective.key.value) }
      },
      legacy: info.legacy,
      warnings: info.warnings
    }));
    return;
  }
  const line = (label, value, source) => {
    console.log(label.padEnd(12) + ": " + value + (source ? "  [" + source + "]" : ""));
  };
  line("file", info.file + (info.exists ? "" : " (missing)"));
  const endpointLine = (key, valueOverride) => {
    const item = info.effective[key];
    const value = valueOverride !== undefined ? valueOverride : item.value;
    line(key, value === "" ? "(none)" : value, item.source);
  };
  if (!info.manual) {
    line("url", "(session provider)", "session");
    line("key", "(session provider)", "session");
    line("model", "(session provider)", "session");
  } else {
    endpointLine("url");
    endpointLine("key", lib.maskSecret(info.effective.key.value));
    endpointLine("model", info.effective.model.value.join(", ") || "(none)");
  }
  line("noAi", String(info.effective.noAi.value), info.effective.noAi.source);
  line("claudeBin", info.effective.claudeBin.value || "(auto)", info.effective.claudeBin.source);
  const msText = (item, httpDefault, cliDefault) => {
    if (item.value !== null) return String(item.value);
    return httpDefault + " (HTTP) / " + cliDefault + " (cli)";
  };
  line("aiTimeoutMs", msText(info.effective.aiTimeoutMs, 8000, 18000),
    info.effective.aiTimeoutMs.source);
  line("aiTotalMs", msText(info.effective.aiTotalMs, 13000, 20000),
    info.effective.aiTotalMs.source);
  line("sourceDir", info.effective.sourceDir.value ||
    "(from .source.json)", info.effective.sourceDir.source);
  for (const warning of info.warnings) console.log("warning    : " + warning);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      "Usage: node config.cjs [options]",
      "",
      "Manage ~/.agents/skills/auto-commit-hook/config.json. The hook only reads",
      "this file; environment variables outrank it per key.",
      "",
      "Manual LLM endpoint (all three together):",
      "  --url <llm-url>        full endpoint URL, anthropic (/v1/messages) or",
      "                         openai (/v1/chat/completions) style",
      "  --key <api-key>        API key (stored in config.json, chmod 600 on unix)",
      "  --model <id[,id...]>   candidate model id(s), tried in order",
      "",
      "Runtime settings (file only; never pass a key through --set):",
      "  --set key=value        one of: noAi, claudeBin, aiTimeoutMs, aiTotalMs,",
      "                         sourceDir; repeatable",
      "  --unset key            remove a saved key; repeatable",
      "",
      "Inspect:",
      "  --show [--json]        effective values and their source (key masked)",
      "  --clear                remove the whole config.json",
      "",
      "Legacy llm-config.json is not read (hard cut); --show reports it if present."
    ].join("\n"));
    return;
  }
  if (opts.clear) {
    const file = lib.userConfigFile();
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(opts.json ? JSON.stringify({ file, cleared: true }) : "Cleared " + file);
    } else {
      console.log(opts.json ? JSON.stringify({ file, cleared: false })
        : "No config to clear (" + file + ").");
    }
    return;
  }
  if (opts.show) {
    show(opts);
    return;
  }
  const result = save(opts);
  if (opts.json) {
    console.log(JSON.stringify({
      file: lib.userConfigFile(),
      exists: true,
      saved: maskedView(result.data),
      warnings: result.warnings
    }));
    return;
  }
  for (const warning of result.warnings) console.log("Warning: " + warning);
  console.log("Saved config:");
  console.log("  file : " + lib.userConfigFile());
  for (const key of lib.USER_CONFIG_KNOWN_KEYS) {
    if (!(key in result.data) || key === "savedAt") continue;
    const value = key === "key" ? lib.maskSecret(result.data[key]) : result.data[key];
    console.log("  " + (key + ":").padEnd(13) + " " +
      (Array.isArray(value) ? value.join(", ") : value));
  }
  console.log("The hook applies this config at runtime; " +
    "AUTOCOMMIT_* env vars still win per key.");
}

try {
  main();
} catch (err) {
  console.error("Error: " + err.message);
  process.exitCode = 1;
}
