#!/usr/bin/env node
// SubHub: lets any AI agent on this computer hand work to your other AI subscriptions ("subs").
// One file, Node.js 18+ built-ins only, macOS / Linux / Windows. No daemon: it finds every signed-in AI
// account, keeps a small registry, and runs a sub on request. https://github.com/PrimeNexes/SubHub · MIT
//
//   subhub list [--refresh]            the subs, what each is for, its limits and models (agents read this)
//   subhub models <sub>                every model that sub offers
//   subhub ask [--in <folder>] <sub> <model|default> [brief | --brief-file <file> | brief on stdin]
//   subhub status [--json] [--refresh] subs, agents and found accounts (--json for scripts)
//   subhub install [--no-rules]        put subhub on PATH and connect every installed agent
//   subhub connect|disconnect <agent|all> [--no-rules]   claude, codex, gemini (Antigravity), cursor
//                                      (connect adds an always-on rule to the agent's global rules file; SUBHUB_NO_RULES=1 skips it)
//   subhub signin <sub> | signin claude --new [--email you@x.com] [--sso]   sign an account in (interactive)
//   subhub remove <sub> · subhub on|off <sub> · subhub config · subhub refresh · subhub version
//   subhub ollama [--model M] [task]   a local Ollama model as an agent that can use your other subs
//
// ask exit codes: 0 answer · 2 bad sub, model or folder · 3 loop guard · 4 empty answer · 6 that sub is you
// 7 not signed in / app not running · 8 turned off · 10 signed in as another account · 124 timeout · 127 CLI missing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.3.0-alpha";
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const HOME = os.homedir();
const SH = path.join(HOME, ".subhub"), REG = path.join(SH, "registry.json"), CFG = path.join(SH, "config.json");
const IGN = path.join(SH, "ignored"), CACHE = path.join(SH, "cache"), LOGS = path.join(SH, "logs"), BIN = path.join(SH, "bin");
const SELF = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(SELF), "..");              // the plugin folder this file came with
const PROVIDERS = ["claude", "codex", "cursor", "gemini", "ollama"];
for (const d of [SH, CACHE, LOGS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- helpers
const die = (code, msg) => { process.stderr.write(`SubHub: ${msg}\n`); process.exit(code); };
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".t", JSON.stringify(o, null, 2) + "\n"); fs.renameSync(f + ".t", f); };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const expand = (p) => p.replace(/^~(?=$|[\\/])/, HOME).replace(/\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%/gi, HOME);
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
const pexist = (p) => fs.existsSync(p);

/** Finds a CLI on PATH and in the usual install folders (PATHEXT on Windows). */
function which(name) {
  const exts = WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").toLowerCase().split(";") : [""];
  const extra = WIN
    ? [path.join(HOME, ".local", "bin"), path.join(process.env.APPDATA || "", "npm"), path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama"), path.join(process.env.LOCALAPPDATA || "", "Programs")]
    : [path.join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/Applications/Ollama.app/Contents/Resources"];
  for (const dir of [...extra, ...(process.env.PATH || "").split(path.delimiter)]) {
    if (!dir) continue;
    for (const e of exts) { const f = path.join(dir, name + e); if (isFile(f)) return f; }
  }
  return null;
}
const BINARY = { claude: "claude", codex: "codex", cursor: "cursor-agent", gemini: "agy", ollama: "ollama" };
const binFor = (p) => which(BINARY[p]);

/** A Windows .cmd/.bat shim (npm installs these) runs through cmd.exe, which needs its own escaping
 * (the same rules as the cross-spawn package). cmd.exe can't pass line breaks: see shimSafe(). */
const isShim = (cmd) => WIN && /\.(cmd|bat)$/i.test(cmd);
const META = /([()\][%!^"`<>&|;, *?])/g;
function escArg(a) {
  a = String(a).replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  return `"${a}"`.replace(META, "^$1").replace(META, "^$1");   // twice: the shim parses its arguments again
}
function prep(cmd, args) {
  if (isShim(cmd)) return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${[cmd.replace(META, "^$1"), ...args.map(escArg)].join(" ")}"`], opts: { windowsVerbatimArguments: true } };
  return { cmd, args, opts: {} };
}
/** Runs a command and waits (for short checks). */
function run(cmd, args, { env, input, timeout = 30000, cwd } = {}) {
  const p = prep(cmd, args);
  const r = spawnSync(p.cmd, p.args, { ...p.opts, env: env || process.env, input, timeout, cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
}
/** The environment for a provider's account folder (claude: CLAUDE_CONFIG_DIR, codex: CODEX_HOME). */
function envFor(provider, dir, base = process.env) {
  const env = { ...base };
  const key = provider === "claude" ? "CLAUDE_CONFIG_DIR" : provider === "codex" ? "CODEX_HOME" : null;
  if (key) { if (dir) env[key] = dir; else delete env[key]; }
  if (!WIN) { env.USER ||= os.userInfo().username; env.LOGNAME ||= env.USER; }   // Claude reads its Keychain item by user name
  return env;
}

// ---------------------------------------------------------------- what each provider is for (shown to agents)
const USE_FOR = {
  claude: "Claude Code on its own usage limit: big side tasks, or when another account is near its limit",
  codex: "Second-opinion code review, debugging",
  cursor: "Coding with the models on the Cursor plan",
  gemini: "Huge context, PDFs and images, web research",
  ollama: "Private data, bulk work, free; local or Ollama cloud models",
};
const LIMITS = {
  claude: "Full Claude Code agent (files, shell, web, its account's skills and MCP servers). Same model family as Claude callers",
  codex: "Full Codex agent (files, shell, network), no sandbox. OpenAI models: a real second opinion",
  cursor: "Full Cursor agent (files, shell, its MCP servers), no sandbox. Models from the Cursor plan",
  gemini: "Full Antigravity agent (files, shell, web), every permission auto-approved. Google models: a real second opinion",
  ollama: "Depends on the model (see Models). With tools it's a full agent (files, shell; web search with OLLAMA_API_KEY); with vision it reads image files named in the brief; audio models get .wav files transcribed; without tools it answers from the brief only. Only while Ollama runs: never start it",
};

// ---------------------------------------------------------------- who an account is
function claudeWho(bin, dir) {
  const r = run(bin, ["auth", "status"], { env: envFor("claude", dir) });
  let j; try { j = JSON.parse(r.out); } catch { return null; }
  if (!j.email) return null;
  const t = (j.subscriptionType || "").toLowerCase();
  return { email: j.email.toLowerCase(), org: j.orgId || "", label: ["team", "enterprise"].includes(t) ? `Claude ${cap(t)} · ${j.orgName || ""}` : `Claude ${cap(t)}`.trim() };
}
function codexWho(home) {
  const tok = readJSON(path.join(home, "auth.json"))?.tokens?.id_token;
  if (!tok) return null;
  try {
    const c = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
    const plan = c["https://api.openai.com/auth"]?.chatgpt_plan_type || "";
    return c.email ? { email: c.email.toLowerCase(), org: plan || "personal", label: `ChatGPT ${cap(plan)}`.trim() } : null;
  } catch { return null; }
}
function cursorWho(bin) {
  const out = run(bin, ["status"]).out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const e = out.match(/Logged in as\s+(\S+)/)?.[1]; if (!e) return null;
  const team = out.match(/^Team:\s*(.*?)\s*\(id/m)?.[1];
  const models = run(bin, ["--list-models"], { timeout: 60000 }).out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/​/g, "");
  fs.writeFileSync(path.join(CACHE, "cursor-models.txt"), models);
  return { email: e.toLowerCase(), org: team || "personal", label: "Cursor" + (team ? ` · ${team}` : "") };
}
function geminiWho(bin) {
  const r = run(bin, ["models"], { timeout: 60000 });
  if (r.code !== 0) return null;
  fs.writeFileSync(path.join(CACHE, "gemini-models.txt"), r.out);
  let email = "google account";
  const logs = path.join(HOME, ".gemini", "antigravity-cli", "log");
  try {
    const files = fs.readdirSync(logs).map((f) => path.join(logs, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of files.slice(0, 20)) {
      const m = [...fs.readFileSync(f, "utf8").matchAll(/applyAuthResult: email=([^,\s]+)/g)].pop();
      if (m) { email = m[1].toLowerCase(); break; }
    }
  } catch {}
  return { email, org: "google", label: "Google account" };
}

// Folders that may hold a sign-in: ~/.claude-*, SubHub's own, and CLAUDE_CONFIG_DIR / CODEX_HOME in shell profiles.
const PROFILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".aliases", ".zsh_aliases",
  path.join("Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), path.join("Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")];
function profileDirs(varName) {
  const out = [];
  for (const rc of PROFILES) {
    let text; try { text = fs.readFileSync(path.join(HOME, rc), "utf8"); } catch { continue; }
    for (const m of text.matchAll(new RegExp(`${varName}\\s*=\\s*["']?([^"'\\s;)]+)`, "g"))) { const d = expand(m[1]); if (isDir(d)) out.push(d); }
  }
  if (process.env[varName] && isDir(process.env[varName])) out.push(process.env[varName]);
  return out;
}
function claudeDirs() {
  const out = [];
  for (const f of fs.readdirSync(HOME)) if (f.startsWith(".claude-") && isDir(path.join(HOME, f))) out.push(path.join(HOME, f));
  const acc = path.join(SH, "accounts");
  if (isDir(acc)) for (const f of fs.readdirSync(acc)) if (f.startsWith("claude") && isDir(path.join(acc, f))) out.push(path.join(acc, f));
  out.push(...profileDirs("CLAUDE_CONFIG_DIR"));
  const def = real(path.join(HOME, ".claude"));
  return [...new Set(out.map(real))].filter((d) => d !== def);
}
const codexDirs = () => ["", ...new Set(profileDirs("CODEX_HOME").map(real).filter((d) => d !== real(path.join(HOME, ".codex"))))];

// ---------------------------------------------------------------- registry: each sub, its pin (email|org) and state
// state: ok | signedout | changed:<email> | stopped (Ollama not running)
function loadReg() {
  const r = readJSON(REG); if (r?.subs) return r;
  const tsv = path.join(SH, "registry.tsv"), subs = [];   // from the shell version
  try {
    for (const l of fs.readFileSync(tsv, "utf8").split("\n").filter(Boolean)) {
      const [name, provider, dir, email, org, label, state] = l.split("\t");
      subs.push({ name, provider, dir, email, org, label, state });
    }
  } catch {}
  return { subs, refreshed: 0 };
}
const saveReg = (r) => writeJSON(REG, r);
const ignored = () => { try { return fs.readFileSync(IGN, "utf8").split("\n").filter(Boolean); } catch { return []; } };
function nextName(reg, p) { const n = Math.max(0, ...reg.subs.filter((s) => s.provider === p).map((s) => +s.name.split("-").pop() || 0)); return `${p}-${n + 1}`; }
const sortSubs = (reg) => reg.subs.sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider) || (+a.name.split("-").pop()) - (+b.name.split("-").pop()));

async function refresh() {
  const reg = loadReg(), ign = ignored();
  const track = (p, dir, w) => {
    if (ign.includes(`${p}:${dir}`)) return;
    const old = reg.subs.find((s) => s.provider === p && s.dir === dir);
    if (old) {
      if (!w) old.state = "signedout";
      else if (`${w.email}|${w.org}` !== `${old.email}|${old.org}`) old.state = `changed:${w.email}`;
      else Object.assign(old, { label: w.label, state: "ok" });
    } else if (w && !reg.subs.some((s) => s.provider === p && `${s.email}|${s.org}` === `${w.email}|${w.org}`)) {
      reg.subs.push({ name: nextName(reg, p), provider: p, dir, email: w.email, org: w.org, label: w.label, state: "ok" });
    }
  };
  let b;
  if ((b = binFor("claude"))) { track("claude", "", claudeWho(b, "")); for (const d of claudeDirs()) track("claude", d, claudeWho(b, d)); }
  if (binFor("codex")) for (const d of codexDirs()) track("codex", d, codexWho(d || path.join(HOME, ".codex")));
  if ((b = binFor("cursor"))) track("cursor", "", cursorWho(b));
  if ((b = binFor("gemini"))) track("gemini", "", geminiWho(b));
  if (binFor("ollama") || process.env.OLLAMA_HOST || reg.subs.some((s) => s.provider === "ollama")) {
    const models = await ollamaModels();
    let o = reg.subs.find((s) => s.provider === "ollama");
    if (models) {
      writeJSON(path.join(CACHE, "ollama-models.json"), models);
      const where = /127\.0\.0\.1|localhost/.test(ollamaHost()) ? "this computer" : ollamaHost();
      if (!o) reg.subs.push(o = { name: nextName(reg, "ollama"), provider: "ollama", dir: "", org: "local" });
      Object.assign(o, { email: where, label: "Ollama", state: "ok" });
    } else if (o) o.state = "stopped";
  }
  sortSubs(reg); reg.refreshed = Date.now(); saveReg(reg);
  return reg;
}
async function fresh(force) {
  const reg = loadReg();
  return force || !reg.subs.length || Date.now() - (reg.refreshed || 0) > 120000 ? refresh() : reg;
}

// ---------------------------------------------------------------- settings (~/.subhub/config.json)
const cfg = () => readJSON(CFG) || { subs: {}, order: [] };
function pref(name, key) { const v = cfg().subs?.[name]?.[key]; return key === "model" && v === "default" ? "" : (v ?? ""); }
const isOn = (name) => cfg().subs?.[name]?.on !== false;
const ranked = (reg) => [...new Set([...(cfg().order || []), ...reg.subs.map((s) => s.name)])].map((n) => reg.subs.find((s) => s.name === n)).filter(Boolean);

// ---------------------------------------------------------------- models
const CLAUDE_MODELS = [
  ["fable", "newest Claude Fable. For your toughest challenges"], ["opus", "newest Claude Opus. Most capable for ambitious work"],
  ["sonnet", "newest Claude Sonnet. Most efficient for everyday tasks"], ["haiku", "newest Claude Haiku. Fastest for quick answers"],
  ["'opus[1m]'", "(also fable[1m], sonnet[1m]): 1M-token context. May use extra usage credits"]];
function models(s, short) {
  const cache = (f) => { try { return fs.readFileSync(path.join(CACHE, f), "utf8"); } catch { return ""; } };
  switch (s.provider) {
    case "claude": return CLAUDE_MODELS.map(([id, d]) => `- \`${id}\`: ${d}`);
    case "gemini": return cache("gemini-models.txt").split("\n").filter((l) => l.includes("\t")).map((l) => {
      const [id, name] = l.split("\t"); let n = "";
      if (/^gemini-.*flash/.test(id)) n = ". 1M-token context; reads images, audio and video";
      if (/-high$/.test(id)) n += "; thinks the most"; if (/-low$/.test(id)) n += "; thinks least, fastest";
      return `- \`${id}\`: ${name}${n}`; });
    case "cursor": {
      const lines = cache("cursor-models.txt").split("\n").map((l) => l.match(/^(\S+) - (.+)$/)).filter(Boolean);
      if (!short) return lines.map((m) => `- \`${m[1]}\`: ${m[2]}`);
      const fam = [...new Set(lines.map((m) => m[2].replace(/\(NO ZDR\)/, "").replace(/(\s+(Low|Medium|High|Extra|Fast|Thinking|Minimal|None|Max|No))+\s*$/, "").trim()))].filter((f) => !/default/i.test(f));
      return [`- \`auto\`: Cursor picks. ${lines.length} models in all; ids: \`subhub models ${s.name}\``, `- families: ${fam.slice(0, 40).join(", ")}`];
    }
    case "codex": {
      const r = run(binFor("codex"), ["debug", "models"], { env: envFor("codex", s.dir) });
      let j; try { j = JSON.parse(r.out); } catch { return []; }
      return (j.models || []).filter((m) => m.visibility === "list").sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map((m) => `- \`${m.slug}\`: ${m.display_name}. ${(m.description || "").replace(/\.$/, "")}; ${Math.round((m.context_window || 0) / 1000)}K context${(m.input_modalities || []).includes("image") ? "; reads images" : ""}`);
    }
    case "ollama": return (readJSON(path.join(CACHE, "ollama-models.json")) || []).map((m) => {
      const c = m.caps; const f = [];
      if (c.includes("embedding") && !c.includes("completion")) f.push("embeddings only: not for tasks");
      else { f.push(c.includes("tools") ? "agent with tools" : "text only"); if (c.includes("vision")) f.push("reads images"); if (c.includes("audio")) f.push("transcribes .wav"); if (c.includes("thinking")) f.push("thinks"); }
      return `- \`${m.name}\`: ${[m.size, m.ctx >= 1000 ? Math.floor(m.ctx / 1024) + "K context" : "", ...f].filter(Boolean).join(", ")}${m.cloud ? "; runs on ollama.com (your Ollama account)" : ""}`; });
  }
  return [];
}

// ---------------------------------------------------------------- list / models / status
async function cmdList(force) {
  const reg = await fresh(force); const out = [];
  out.push("# Your subs (from SubHub)", "", "Run one with `subhub ask <sub> <model|default>` and the brief (see the subhub skill). Never pick the account you are running as.", "",
    "| Sub | Account | Use it for | Can do, and limits |", "|---|---|---|---|");
  const ready = [], off = [], waiting = [];
  for (const s of ranked(reg)) {
    if (!isOn(s.name)) { off.push(s.name); continue; }
    if (s.state === "signedout") { waiting.push(`${s.name} (signed out)`); continue; }
    if (s.state.startsWith("changed:")) { waiting.push(`${s.name} (signed in as ${s.state.slice(8)}, not ${s.email})`); continue; }
    if (s.state === "stopped") { waiting.push(`${s.name} (Ollama isn't running)`); continue; }
    out.push(`| ${s.name} | ${s.email}, ${s.label} | ${pref(s.name, "use_for") || USE_FOR[s.provider]} | ${LIMITS[s.provider]} |`); ready.push(s);
  }
  out.push("", "All subs start fresh (no memory of your conversation), run headless (they can't ask questions), with full access and no approval prompts, in the folder you call from (or `--in <folder>`), for up to 30 minutes.",
    "", "## Models", "", "Pass an id as the 2nd argument, or default. Quote ids with brackets.");
  let firstClaude = null;
  for (const s of ready) {
    const m = pref(s.name, "model");
    if (s.provider === "claude") { if (m) out.push("", `**${s.name}**: the user picked \`${m}\`: pass default unless the task needs another.`); firstClaude ||= s; continue; }
    out.push("", `**${s.name}**${m ? ` (the user picked \`${m}\`: pass default unless the task needs another)` : ""}`, ...models(s, true));
  }
  if (firstClaude) out.push("", `**Every Claude sub** (${ready.filter((s) => s.provider === "claude").map((s) => s.name).join(", ")})`, ...models(firstClaude, true));
  if (off.length) out.push("", `Turned off by the user, don't use: ${off.join(", ")}`);
  if (waiting.length) out.push("", `Not ready: ${waiting.join(", ")}. The user fixes these with \`subhub status\`.`);
  console.log(out.join("\n"));
}
async function cmdModels(name) {
  if (!name) die(2, "name a sub, for example: subhub models gemini-1");
  const s = (await fresh()).subs.find((x) => x.name === name) || die(2, `no sub named '${name}'. subhub list shows them.`);
  console.log([`# ${name} models`, "", ...models(s, false)].join("\n"));
}

// Claude organizations named in account records on this computer that no folder is signed in to.
function found(reg) {
  const files = [path.join(HOME, ".claude.json")];
  const add = (dir, filter = () => true) => { try { for (const f of fs.readdirSync(dir).filter(filter)) files.push(path.join(dir, f)); } catch {} };
  add(path.join(HOME, ".claude", "backups"), (f) => f.startsWith(".claude.json.backup."));
  for (const s of reg.subs.filter((x) => x.provider === "claude" && x.dir)) files.push(path.join(s.dir, ".claude.json"));
  const desktop = MAC ? path.join(HOME, "Library", "Application Support", "Claude") : WIN ? path.join(process.env.APPDATA || "", "Claude") : path.join(HOME, ".config", "Claude");
  const lams = path.join(desktop, "local-agent-mode-sessions");
  try { for (const a of fs.readdirSync(lams)) for (const o of fs.readdirSync(path.join(lams, a))) for (const s of fs.readdirSync(path.join(lams, a, o)).slice(0, 10)) files.push(path.join(lams, a, o, s, ".claude", ".claude.json")); } catch {}
  const have = new Set(reg.subs.filter((s) => s.provider === "claude").map((s) => `${s.email}|${s.org}`)), ign = ignored(), out = new Map();
  for (const f of files) {
    const a = readJSON(f)?.oauthAccount; if (!a?.emailAddress || !a.organizationUuid) continue;
    const k = `${a.emailAddress.toLowerCase()}|${a.organizationUuid}`;
    if (have.has(k) || ign.includes(`found:${k}`) || out.has(k)) continue;
    out.set(k, { email: a.emailAddress.toLowerCase(), org: a.organizationUuid, orgName: a.organizationName || "", type: (a.organizationType || "").replace("claude_", "") });
  }
  return [...out.values()];
}
async function cmdStatus(args) {
  const reg = await fresh(args.includes("--refresh"));
  const agents = AGENTS.map((a) => ({ id: a, name: AGENT_NAME[a], installed: !!binFor(a), connected: agentOn(a), rules: !!rulesIn(a), rulesFile: rulesIn(a) || RULE_FILES[a]()[0] || null }));
  const f = found(reg);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ version: VERSION, subs: reg.subs.map((s) => ({ name: s.name, provider: s.provider, folder: s.dir, email: s.email, label: s.label, state: s.state, on: isOn(s.name) })), agents, found: f }));
    return;
  }
  console.log("Subs:"); for (const s of reg.subs) console.log(`  ${s.name.padEnd(10)} ${s.email.padEnd(28)} ${s.label.padEnd(26)} ${isOn(s.name) ? s.state : "off"}`);
  console.log("Agents:"); for (const a of agents) console.log(`  ${a.name.padEnd(12)} ${!a.installed ? "not installed" : a.connected ? "connected" : `not connected (subhub connect ${a.id})`}${a.rules ? `, always-on rule in ${a.rulesFile}` : ""}`);
  if (f.length) { console.log("Found, not signed in (subhub signin claude --new --email <email>):"); for (const x of f) console.log(`  ${x.email} · ${["team", "enterprise"].includes(x.type) ? "Team " + x.orgName : "Personal"}`); }
}

// ---------------------------------------------------------------- ask
const CALLER_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE"];
const readStdin = () => { try { return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"); } catch { return ""; } };
function gitSnap(cwd) {
  const st = run("git", ["status", "--porcelain", "-uall"], { cwd }); if (st.code !== 0) return null;
  return crypto.createHash("sha1").update(st.out + run("git", ["diff"], { cwd }).out).digest("hex");
}

async function cmdAsk(argv) {
  const args = [...argv]; let briefFile = null;
  if (args[0] === "--in") { try { process.chdir(expand(args[1])); } catch { die(2, `can't open the folder '${args[1]}'.`); } args.splice(0, 2); }
  const bf = args.indexOf("--brief-file"); if (bf >= 0) { briefFile = args[bf + 1]; args.splice(bf, 2); }
  // Who is calling: a Claude Code session says so in its environment. Any agent may call.
  const env = { ...process.env };
  const caller = env.CLAUDE_CODE_USER_EMAIL ? `${env.CLAUDE_CODE_USER_EMAIL.toLowerCase()}|${env.CLAUDE_CODE_ORGANIZATION_UUID || ""}` : "";
  const inClaude = !!env.CLAUDECODE, callerDir = env.CLAUDE_CONFIG_DIR || "";
  for (const v of CALLER_VARS) delete env[v];          // a sub uses its own sign-in, never the caller's
  const timeout = (+env.SUBHUB_TIMEOUT || 1800) * 1000, max = +env.SUBHUB_MAX_DEPTH || 1, depth = +env.SUBHUB_DEPTH || 0;
  if (depth >= max) die(3, `loop guard: depth ${max} reached`);
  env.SUBHUB_DEPTH = String(depth + 1);
  let [name, model = "default", task = ""] = args;
  if (!task) task = briefFile ? fs.readFileSync(expand(briefFile), "utf8") : readStdin();
  let reg = loadReg(), s = reg.subs.find((x) => x.name === name);
  if (!s) { reg = await refresh(); s = reg.subs.find((x) => x.name === name); }
  if (!s) die(2, `unknown sub '${name}'. subhub list shows them.`);
  if (!isOn(name)) die(8, `${name} is turned off.`);
  if (s.state === "signedout") die(7, `${name} is signed out. Sign it in with: subhub signin ${name}`);
  if (s.state.startsWith("changed:")) die(10, `${name} isn't signed in as ${s.email} any more (it's ${s.state.slice(8)}). Sign it in again: subhub signin ${name}`);
  if (s.state === "stopped") die(7, "Ollama isn't running. Start it yourself; SubHub never starts it.");
  if (model === "default" && pref(name, "model")) model = pref(name, "model");
  if (!/^[A-Za-z0-9._:/\[\]-]+$/.test(model)) die(2, `'${model}' isn't a model name.`);
  const notes = pref(name, "notes");
  let brief = `Task from another AI agent. You're its sub-agent, working in ${process.cwd()}. You run headless: nobody can answer questions, so make sensible choices and finish. If you change any files, list them at the end.\n${task}`;
  if (notes) brief += `\n\nNotes from the user for this sub:\n${notes}`;
  brief += "\n\nYou are a sub-agent. Do not delegate further.";
  const before = gitSnap(process.cwd());
  let answer = "", code = 0, logf = path.join(LOGS, `${name}.log`);
  if (s.provider === "ollama") {
    if (model === "default") model = ollamaDefault(reg);
    if (!model) die(7, "Ollama has no models. Pull one yourself (ollama pull <model>); SubHub never downloads models.");
    const tags = await ollamaModels(); if (!tags) die(7, `Ollama isn't running at ${ollamaHost()}. Start it yourself; SubHub never starts it.`);
    if (!model.includes(":")) model += ":latest";
    if (!tags.some((m) => m.name === model)) die(7, `${model} isn't installed in Ollama, and SubHub won't download it.`);
    process.env.SUBHUB_DEPTH = env.SUBHUB_DEPTH;
    try { answer = (await withTimeout(ollamaAgent(model, brief, false), timeout)).answer; }
    catch (e) { code = e.timeout ? 124 : 1; fs.appendFileSync(logf, String(e.message || e) + "\n"); }
  } else {
    const bin = binFor(s.provider) || die(127, `${name}'s CLI isn't installed.`);
    let cmdArgs;
    if (s.provider === "claude") {
      if (caller && caller === `${s.email}|${s.org}`) die(6, `${name} is the account you're running as. Pick another sub.`);
      if (inClaude && real(callerDir || path.join(HOME, ".claude")) === real(s.dir || path.join(HOME, ".claude"))) die(6, `${name} is the Claude account you're running as. Pick another sub.`);
      const w = claudeWho(bin, s.dir); if (!w || `${w.email}|${w.org}` !== `${s.email}|${s.org}`) die(10, `${name} isn't signed in as ${s.email} any more. Sign it in again: subhub signin ${name}`);
      Object.assign(env, envFor("claude", s.dir, env)); delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
      cmdArgs = ["-p", "--permission-mode", "bypassPermissions", "--settings", '{"disableAllHooks":true}', ...(model !== "default" ? ["--model", model] : []), brief];
    } else if (s.provider === "codex") {
      Object.assign(env, envFor("codex", s.dir, env)); if (!s.dir) delete env.CODEX_HOME;
      cmdArgs = ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "-c", 'approval_policy="never"', ...(model !== "default" ? ["--model", model] : []), brief];
    } else if (s.provider === "cursor") cmdArgs = ["--force", "--sandbox", "disabled", "--trust", "--approve-mcps", ...(model !== "default" ? ["--model", model] : []), "-p", brief];
    else cmdArgs = ["--dangerously-skip-permissions", ...(model !== "default" ? ["--model", model] : []), "-p", brief];
    let input;
    if (isShim(bin)) {   // cmd.exe can't carry line breaks in an argument
      const i = cmdArgs.lastIndexOf(brief);
      if (s.provider === "claude") { cmdArgs.splice(i, 1); input = brief; }
      else if (s.provider === "codex") { cmdArgs[i] = "-"; input = brief; }
      else cmdArgs[i] = brief.replace(/\r?\n+/g, " ");
    }
    ({ out: answer, code } = await runSub(bin, cmdArgs, env, timeout, logf, input));
  }
  answer = (answer || "").trim();
  if (code === 0 && !answer) code = 4;
  if (code !== 0) {
    if (code === 124) process.stderr.write(`SubHub: ${name} timed out after ${timeout / 1000} seconds.\n`);
    let tail = ""; try { tail = fs.readFileSync(logf, "utf8").trim().split("\n").slice(-5).join("\n"); } catch {}
    process.stderr.write(`SubHub: ${name} failed (exit ${code}). Last log lines:\n${tail}\n`);
  }
  if (answer) console.log(answer);
  if (before && before !== gitSnap(process.cwd())) console.log(`\nSubHub: files in ${process.cwd()} that changed while ${name} ran (git status; includes anything else working here):\n${run("git", ["status", "--porcelain", "-uall"]).out.trimEnd()}`);
  process.exit(code);
}
/** Runs a sub's CLI with a time limit; on timeout the whole process tree is stopped. */
function runSub(bin, args, env, timeout, logf, input) {
  return new Promise((resolve) => {
    const p = prep(bin, args);
    const child = spawn(p.cmd, p.args, { ...p.opts, env, detached: !WIN, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin.end(input);
    let out = "", timedOut = false; const log = fs.createWriteStream(logf, { flags: "a" });
    child.stdout.on("data", (d) => (out += d)); child.stderr.pipe(log);
    const t = setTimeout(() => {
      timedOut = true;
      if (WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000).unref(); }
    }, timeout);
    child.on("error", (e) => { clearTimeout(t); log.end(); resolve({ out: "", code: 127 }); fs.appendFileSync(logf, String(e) + "\n"); });
    child.on("close", (c) => { clearTimeout(t); log.end(); resolve({ out, code: timedOut ? 124 : (c ?? 1) }); });
  });
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { timeout: true })), ms).unref())]);

// ---------------------------------------------------------------- Ollama: its HTTP API, every feature the model reports
const ollamaHost = () => { const h = process.env.OLLAMA_HOST || "127.0.0.1:11434"; return h.startsWith("http") ? h : "http://" + h; };
async function oapi(p, body, { base = ollamaHost(), auth = false, timeout = 1800000 } = {}) {
  const r = await fetch(base + p, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer " + process.env.OLLAMA_API_KEY } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Ollama ${p} failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function ollamaShow(model) {
  const d = await oapi("/api/show", { model }, { timeout: 30000 });
  const ctx = Object.entries(d.model_info || {}).find(([k, v]) => k.endsWith(".context_length") && typeof v === "number")?.[1] || 0;
  return { caps: d.capabilities || [], ctx, size: d.details?.parameter_size || "", thinking: d.thinking || {} };
}
async function ollamaModels() {
  let tags; try { tags = await oapi("/api/tags", undefined, { timeout: 3000 }); } catch { return null; }
  const out = [];
  for (const m of tags.models || []) {
    const name = m.name || m.model; let s = { caps: [], ctx: 0, size: "" };
    try { s = await ollamaShow(name); } catch {}
    out.push({ name, caps: s.caps, ctx: s.ctx, size: s.size, cloud: !!(m.remote_host || /:cloud$|-cloud$/.test(name)) });
  }
  return out;
}
function ollamaDefault(reg) {   // the user's pick, else the first local model that can use tools, else the first model
  const o = reg.subs.find((s) => s.provider === "ollama"); const p = o && pref(o.name, "model"); if (p) return p;
  const ms = readJSON(path.join(CACHE, "ollama-models.json")) || [];
  return (ms.find((m) => !m.cloud && m.caps.includes("tools")) || ms[0])?.name || "";
}
const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
function pathsIn(text, re) {
  const out = [];
  for (const m of text.match(/(?:[A-Za-z]:[\\/]|~|\.{0,2}[\\/])?[\w@%+=:,.\\/~-]+/g) || []) {
    const p = expand(m.replace(/^[.,;:()"']+|[.,;:()"']+$/g, ""));
    if (re.test(p) && isFile(p) && !out.includes(p)) out.push(p);
  }
  return out;
}
const tool = (name, description, props, required) => ({ type: "function", function: { name, description, parameters: { type: "object", properties: props, required } } });
const S = { type: "string" }, N = { type: "integer" };
const shellRun = (command, timeout = 300) => { const r = spawnSync(command, { shell: true, encoding: "utf8", timeout: timeout * 1000, windowsHide: true, maxBuffer: 64 << 20 }); return `exit ${r.status}\n${(r.stdout || "").slice(-20000)}${(r.stderr || "").slice(-5000)}`; };
const TOOLS = {
  read_file: [({ path: p, max_bytes = 200000 }) => fs.readFileSync(expand(p)).subarray(0, max_bytes).toString(), tool("read_file", "Read a text file.", { path: S, max_bytes: N }, ["path"])],
  write_file: [({ path: p, content }) => { fs.mkdirSync(path.dirname(path.resolve(expand(p))), { recursive: true }); fs.writeFileSync(expand(p), content); return `wrote ${content.length} characters to ${p}`; }, tool("write_file", "Create or overwrite a file with the given content.", { path: S, content: S }, ["path", "content"])],
  list_dir: [({ path: p = "." }) => fs.readdirSync(expand(p)).sort().slice(0, 500).map((e) => e + (isDir(path.join(expand(p), e)) ? "/" : "")).join("\n"), tool("list_dir", "List a folder.", { path: S }, [])],
  run_command: [({ command, timeout }) => shellRun(command, timeout), tool("run_command", `Run a shell command (${WIN ? "cmd.exe" : "sh"}) in the working folder; returns exit code and output.`, { command: S, timeout: N }, ["command"])],
};
const WEB = {
  web_search: [async ({ query, max_results = 5 }) => JSON.stringify((await oapi("/api/web_search", { query, max_results }, { base: "https://ollama.com", auth: true, timeout: 60000 })).results || []).slice(0, 20000), tool("web_search", "Search the web (Ollama web search).", { query: S, max_results: N }, ["query"])],
  web_fetch: [async ({ url }) => { const d = await oapi("/api/web_fetch", { url }, { base: "https://ollama.com", auth: true, timeout: 60000 }); return `${d.title || ""}\n${d.content || ""}`.slice(0, 20000); }, tool("web_fetch", "Fetch a web page's text.", { url: S }, ["url"])],
};
const self = (args, input) => spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", input, windowsHide: true, maxBuffer: 64 << 20 });
const SUBS = {
  subhub_list: [() => self(["list"]).stdout, tool("subhub_list", "List the user's other AI subscriptions (subs): what each is for, limits, models.", {}, [])],
  subhub_ask: [({ sub, brief, model = "default" }) => { const r = self(["ask", sub, model], brief); return `exit ${r.status}\n${(r.stdout || "").slice(-20000)}${(r.stderr || "").slice(-3000)}`; },
    tool("subhub_ask", "Hand a self-contained task to one sub; returns its answer.", { sub: S, brief: S, model: { type: "string", description: "a model id from subhub_list, or default" } }, ["sub", "brief"])],
};
async function transcribe(file, model) {
  const fd = new FormData();
  fd.append("model", model); fd.append("response_format", "text");
  fd.append("file", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), path.basename(file));
  try { const r = await fetch(ollamaHost() + "/v1/audio/transcriptions", { method: "POST", body: fd }); return (await r.text()).trim(); }
  catch (e) { return `(couldn't transcribe: ${e.message})`; }
}
/** One task for an Ollama model, using what it supports: tools, vision, audio, thinking, its full context. */
async function ollamaAgent(model, task, driver, history = null) {
  const s = await ollamaShow(model); const caps = s.caps, tools = {};
  if (caps.includes("tools")) {
    Object.assign(tools, TOOLS);
    if (process.env.OLLAMA_API_KEY) Object.assign(tools, WEB);
    if (driver && (+process.env.SUBHUB_DEPTH || 0) < (+process.env.SUBHUB_MAX_DEPTH || 1)) Object.assign(tools, SUBS);
  }
  const msg = { role: "user", content: task };
  if (caps.includes("vision")) { const imgs = pathsIn(task, IMG); if (imgs.length) msg.images = imgs.map((p) => fs.readFileSync(p).toString("base64")); }
  if (caps.includes("audio")) for (const w of pathsIn(task, /\.wav$/i)) msg.content += `\n\nTranscript of ${w}:\n${await transcribe(w, model)}`;
  if (!history) history = [{ role: "system", content: `You are working as an agent on the user's computer (${process.platform}), in ${process.cwd()}. `
    + (Object.keys(tools).length ? "Use your tools to read, change and check things instead of guessing. " : "You have no tools: answer from the text you are given. ")
    + (tools.subhub_ask ? "You can hand self-contained tasks to the user's other AI subscriptions with subhub_list and subhub_ask; pick the sub that fits, never put secrets in a brief, and check what they return. " : "")
    + "Finish the task, then give a short final answer." }];
  history.push(msg);
  const req = { model, messages: history, stream: false, options: s.ctx ? { num_ctx: Math.min(s.ctx, +process.env.SUBHUB_OLLAMA_CTX || 65536) } : {} };
  if (Object.keys(tools).length) req.tools = Object.values(tools).map((t) => t[1]);
  if (caps.includes("thinking")) { const t = process.env.SUBHUB_OLLAMA_THINK; req.think = t ? ({ true: true, false: false }[t] ?? t) : true; }
  for (let i = 0; i < (+process.env.SUBHUB_OLLAMA_STEPS || 40); i++) {
    const out = (await oapi("/api/chat", req)).message || {};
    history.push({ role: "assistant", content: out.content || "", ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) });
    if (!out.tool_calls?.length) return { answer: (out.content || "").trim(), history };
    for (const c of out.tool_calls) {
      const name = c.function?.name; let a = c.function?.arguments || {};
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
      let result; try { result = tools[name] ? await tools[name][0](a) : `no tool named ${name}`; } catch (e) { result = `error: ${e.message}`; }
      if (process.env.SUBHUB_OLLAMA_VERBOSE) process.stderr.write(`· ${name} ${JSON.stringify(a).slice(0, 120)}\n`);
      history.push({ role: "tool", tool_name: name, content: String(result).slice(0, 30000) });
    }
  }
  return { answer: "Stopped before a final answer (step limit).", history };
}
async function cmdOllama(argv) {
  const args = [...argv]; let model = "";
  if (args[0] === "--model") { model = args[1]; args.splice(0, 2); }
  const reg = await fresh(); model ||= ollamaDefault(reg);
  if (!model) die(7, "Ollama isn't running or has no models.");
  const task = args.join(" ");
  if (task) { console.log((await ollamaAgent(model, task, true)).answer); return; }
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  process.stderr.write(`Local agent on ${model}. It can hand work to your subs. Ctrl-D to quit.\n`); let history = null; rl.prompt();
  for await (const line of rl) { if (line.trim()) { const r = await ollamaAgent(model, line, true, history); history = r.history; console.log(r.answer); } rl.prompt(); }
}

// ---------------------------------------------------------------- agents: Claude Code, Codex, Antigravity, Cursor
const AGENTS = ["claude", "codex", "gemini", "cursor"];
const AGENT_NAME = { claude: "Claude Code", codex: "Codex", gemini: "Antigravity", cursor: "Cursor" };
const codexHome = () => process.env.CODEX_HOME || path.join(HOME, ".codex");
const SKILL_DIR = { codex: () => path.join(codexHome(), "skills", "subhub"), gemini: () => path.join(HOME, ".gemini", "config", "skills", "subhub"), cursor: () => path.join(HOME, ".cursor", "skills", "subhub") };
const launcher = () => path.join(BIN, WIN ? "subhub.cmd" : "subhub");
const RULES = () => ["subhub", launcher()];
function agentOn(a) {
  if (a === "claude") return JSON.stringify(readJSON(path.join(HOME, ".claude", "plugins", "installed_plugins.json")) || "").includes('"subhub@') || pexist(path.join(HOME, ".claude", "skills", "subhub", "bin", "subhub.mjs"));
  if (a === "codex") return pexist(path.join(codexHome(), "plugins", "cache", "subhub")) || pexist(path.join(SKILL_DIR.codex(), "SKILL.md"));
  if (a === "gemini") return pexist(path.join(HOME, ".gemini", "config", "plugins", "subhub")) || pexist(path.join(SKILL_DIR.gemini(), "SKILL.md"));
  return pexist(path.join(SKILL_DIR.cursor(), "SKILL.md"));
}
/** Adds or removes one entry in permissions.allow of a JSON settings file (backed up once). */
function allow(add, file, rule) {
  let o = {};
  if (pexist(file)) { o = readJSON(file); if (!o) { process.stderr.write(`  SubHub: ${file} isn't valid JSON; add ${rule} to permissions.allow yourself.\n`); return; } if (!pexist(file + ".subhub-backup")) fs.copyFileSync(file, file + ".subhub-backup"); }
  else if (!add) return;
  o.permissions ||= {}; o.permissions.allow ||= [];
  const has = o.permissions.allow.includes(rule);
  if (add === has) return;
  o.permissions.allow = add ? [...o.permissions.allow, rule] : o.permissions.allow.filter((r) => r !== rule);
  writeJSON(file, o);
}
// The always-on rule: a marked block in each agent's global instructions file, so the agent uses subs by default.
// Claude Code ~/.claude/CLAUDE.md · Codex <CODEX_HOME>/AGENTS.md (AGENTS.override.md if that's the one Codex reads)
// · Antigravity ~/.gemini/config/AGENTS.md (~/.gemini/GEMINI.md is shared with Gemini CLI) · Cursor: none (no per-user rules file).
const RULE_START = "<!-- subhub:start", RULE_END = "<!-- subhub:end -->", RULE_STATE = path.join(SH, "rules.json");
const RULE_BLOCK = [`${RULE_START} v${VERSION}: written by SubHub, removed by subhub disconnect -->`,
  "## Use the user's other AI subscriptions (SubHub) first",
  "- Before starting a built-in sub-agent, or doing delegable side work (wide file reads, research, reviews, independent edits, parallel pieces), run `subhub list` and hand the work to a ready sub with `subhub ask` (details in the subhub skill). This saves this account's usage.",
  "- Do it yourself or with built-in sub-agents only when `subhub list` shows no ready sub, the task is a few tool calls, the work needs this conversation's context that can't be put in a brief, or the brief would have to contain secrets.",
  "- If you are running as a sub yourself (the brief says you are a sub-agent, or SUBHUB_DEPTH is set), don't delegate.",
  "- Run `subhub` as the whole command, with nothing chained before or after it.",
  RULE_END];
const nonEmpty = (f) => { try { return fs.readFileSync(f, "utf8").trim() !== ""; } catch { return false; } };
const RULE_FILES = {   // every file SubHub may have put the block in; the first is where connect writes it
  claude: () => [path.join(HOME, ".claude", "CLAUDE.md")],
  codex: () => { const o = path.join(codexHome(), "AGENTS.override.md"), a = path.join(codexHome(), "AGENTS.md"); return nonEmpty(o) ? [o, a] : [a, o]; },
  gemini: () => [path.join(HOME, ".gemini", "config", "AGENTS.md")],
  cursor: () => [],
};
/** Where the block is: [start, end) of the block itself, or null. */
function findBlock(text) {
  const s = text.indexOf(RULE_START); if (s < 0) return null;
  const e = text.indexOf(RULE_END, s); return e < 0 ? null : [s, e + RULE_END.length];
}
const readText = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const rulesIn = (a) => RULE_FILES[a]().find((f) => findBlock(readText(f) || "")) || null;
/** Writes (or refreshes in place) the block. Everything else in the file stays byte for byte; writes through symlinks. */
function addRules(file) {
  const old = readText(file), text = old ?? "", eol = text.includes("\r\n") ? "\r\n" : "\n", block = RULE_BLOCK.join(eol), at = findBlock(text);
  let next;
  if (at) next = text.slice(0, at[0]) + block + text.slice(at[1]);
  else {
    const before = !text ? "" : /\r?\n$/.test(text) ? eol : eol + eol;
    next = text + before + block + eol;
    const st = readJSON(RULE_STATE) || {}; st[file] = { created: old === null, before }; writeJSON(RULE_STATE, st);
  }
  if (next === text) return;
  if (old !== null && !pexist(file + ".subhub-backup")) fs.copyFileSync(file, file + ".subhub-backup");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);   // an existing file keeps its mode, and a symlink stays a symlink
}
/** Removes the block and the separator SubHub added; deletes the file only if SubHub created it and it's now empty. */
function removeRules(file) {
  const text = readText(file); if (text === null) return;
  const at = findBlock(text); if (!at) return;
  const st = readJSON(RULE_STATE) || {}, rec = st[file] || { created: !pexist(file + ".subhub-backup"), before: null };
  let head = text.slice(0, at[0]), tail = text.slice(at[1]).replace(/^\r?\n/, "");
  if (rec.before === null) { const m = head.match(/(\r?\n)\1$/); if (m && /\S/.test(head)) head = head.slice(0, -m[1].length); }   // no record: undo a usual blank line
  else if (rec.before && head.endsWith(rec.before)) head = head.slice(0, -rec.before.length);
  const next = head + tail;
  if (!next && rec.created) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, next);
  delete st[file]; writeJSON(RULE_STATE, st);
}
const copyDir = (from, to) => { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); };
const quiet = (bin, args) => run(bin, args, { timeout: 180000 }).code === 0;
function connect(a, rules = !process.env.SUBHUB_NO_RULES) {
  const b = binFor(a); if (!b) { console.log(`  ${AGENT_NAME[a]}: not installed, skipped`); return; }
  const market = process.env.SUBHUB_MARKET || process.env.SUBHUB_REPO || path.resolve(SRC, "..", "..");
  if (a === "claude") {
    quiet(b, ["plugin", "marketplace", "remove", "subhub"]); quiet(b, ["plugin", "marketplace", "add", market]);
    quiet(b, ["plugin", "install", "subhub@subhub"]); quiet(b, ["plugin", "update", "subhub@subhub"]);
    if (!agentOn("claude")) copyDir(SRC, path.join(HOME, ".claude", "skills", "subhub"));
    const f = path.join(HOME, ".claude", "settings.json");
    for (const r of RULES()) allow(true, f, `Bash(${r} *)`); allow(true, f, "Skill(subhub:subhub)");
  } else if (a === "codex") {
    quiet(b, ["plugin", "remove", "subhub"]); quiet(b, ["plugin", "marketplace", "remove", "subhub"]); quiet(b, ["plugin", "marketplace", "add", market]);
    if (!quiet(b, ["plugin", "add", "subhub@subhub"])) copyDir(path.join(SRC, "skills", "subhub"), SKILL_DIR.codex());
    const rules = path.join(codexHome(), "rules", "subhub.rules"); fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.writeFileSync(rules, "# Written by SubHub: lets Codex run subhub without asking.\n" + RULES().map((r) => `prefix_rule(pattern = [${JSON.stringify(r)}], decision = "allow")`).join("\n") + "\n");
  } else if (a === "gemini") {
    quiet(b, ["plugin", "uninstall", "subhub"]);
    if (!quiet(b, ["plugin", "install", SRC])) copyDir(path.join(SRC, "skills", "subhub"), SKILL_DIR.gemini());
    for (const r of RULES()) allow(true, path.join(HOME, ".gemini", "antigravity-cli", "settings.json"), `command(${r})`);
  } else {
    copyDir(path.join(SRC, "skills", "subhub"), SKILL_DIR.cursor());
    for (const r of RULES()) allow(true, path.join(HOME, ".cursor", "cli-config.json"), `Shell(${r})`);
  }
  let note = "";
  if (!RULE_FILES[a]().length) note = "; no global rules file to write the always-on rule to (skill only)";
  else if (rules) { const f = RULE_FILES[a]()[0]; addRules(f); note = `; always-on rule in ${f}`; }
  else note = "; always-on rule skipped";
  console.log(`  ${AGENT_NAME[a]}: connected${note}`);
}
function disconnect(a) {
  const b = binFor(a);
  if (a === "claude") {
    if (b) { quiet(b, ["plugin", "uninstall", "subhub@subhub"]); quiet(b, ["plugin", "marketplace", "remove", "subhub"]); }
    if (pexist(path.join(HOME, ".claude", "skills", "subhub", "bin", "subhub.mjs"))) fs.rmSync(path.join(HOME, ".claude", "skills", "subhub"), { recursive: true, force: true });
    const f = path.join(HOME, ".claude", "settings.json"); for (const r of RULES()) allow(false, f, `Bash(${r} *)`); allow(false, f, "Skill(subhub:subhub)");
  } else if (a === "codex") {
    if (b) { quiet(b, ["plugin", "remove", "subhub"]); quiet(b, ["plugin", "marketplace", "remove", "subhub"]); }
    fs.rmSync(SKILL_DIR.codex(), { recursive: true, force: true }); fs.rmSync(path.join(codexHome(), "rules", "subhub.rules"), { force: true });
  } else if (a === "gemini") {
    if (b) quiet(b, ["plugin", "uninstall", "subhub"]); fs.rmSync(SKILL_DIR.gemini(), { recursive: true, force: true });
    for (const r of RULES()) allow(false, path.join(HOME, ".gemini", "antigravity-cli", "settings.json"), `command(${r})`);
  } else {
    fs.rmSync(SKILL_DIR.cursor(), { recursive: true, force: true });
    for (const r of RULES()) allow(false, path.join(HOME, ".cursor", "cli-config.json"), `Shell(${r})`);
  }
  for (const f of RULE_FILES[a]()) removeRules(f);
  console.log(`  ${AGENT_NAME[a]}: disconnected`);
}

// ---------------------------------------------------------------- install, sign-in, settings
/** Removes what older SubHub versions wrote (the macOS app's skills-dir plugin, relay agents, ask rules, the shell engine). */
function migrate() {
  const old = path.join(SH, "ask");
  const sd = path.join(HOME, ".claude", "skills", "subhub");
  if (pexist(path.join(sd, ".claude-plugin", "plugin.json")) && !pexist(path.join(sd, "bin", "subhub.mjs"))) fs.rmSync(sd, { recursive: true, force: true });
  try { for (const f of fs.readdirSync(path.join(HOME, ".claude", "agents"))) { const p = path.join(HOME, ".claude", "agents", f); if (/^subhub-.*\.md$/.test(f) && fs.readFileSync(p, "utf8").includes("Written by SubHub")) fs.rmSync(p); } } catch {}
  allow(false, path.join(HOME, ".claude", "settings.json"), `Bash(${old} *)`); allow(false, path.join(HOME, ".claude", "settings.json"), "Bash(~/.subhub/bin/subhub *)");
  allow(false, path.join(HOME, ".gemini", "antigravity-cli", "settings.json"), `command(${old})`);
  allow(false, path.join(HOME, ".cursor", "cli-config.json"), `Shell(${old})`);
  for (const f of ["subhub-ollama", "subs.md", "registry.tsv"]) fs.rmSync(path.join(f === "subhub-ollama" ? BIN : SH, f), { force: true });
  for (const d of ["models", "run"]) fs.rmSync(path.join(SH, d), { recursive: true, force: true });
  if (!WIN) { fs.writeFileSync(old, `#!/bin/sh\n# Old name for subhub, kept so older sessions keep working.\ncase $1 in --list) exec "${launcher()}" list ;; --models) exec "${launcher()}" models "$2" ;; esac\nexec "${launcher()}" ask "$@"\n`); fs.chmodSync(old, 0o755); }
}
async function cmdInstall(rules) {
  fs.mkdirSync(BIN, { recursive: true });
  fs.copyFileSync(SELF, path.join(BIN, "subhub.mjs"));
  if (WIN) {
    fs.writeFileSync(path.join(BIN, "subhub.cmd"), `@echo off\r\nnode "%~dp0subhub.mjs" %*\r\n`);
    const userPath = run("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"]).out.trim();
    if (!userPath.toLowerCase().split(";").includes(BIN.toLowerCase())) {
      run("powershell", ["-NoProfile", "-Command", `[Environment]::SetEnvironmentVariable('Path', (([Environment]::GetEnvironmentVariable('Path','User') -split ';' | Where-Object { $_ }) + '${BIN}') -join ';', 'User')`]);
      console.log(`  Added ${BIN} to your user PATH. Open a new terminal to use subhub.`);
    }
  } else {
    fs.writeFileSync(path.join(BIN, "subhub"), `#!/bin/sh\ncommand -v node >/dev/null 2>&1 || { echo "SubHub needs Node.js 18 or newer: https://nodejs.org" >&2; exit 127; }\nexec node "${path.join(BIN, "subhub.mjs")}" "$@"\n`);
    fs.chmodSync(path.join(BIN, "subhub"), 0o755);
    const lb = path.join(HOME, ".local", "bin"); fs.mkdirSync(lb, { recursive: true });
    fs.rmSync(path.join(lb, "subhub"), { force: true }); fs.symlinkSync(path.join(BIN, "subhub"), path.join(lb, "subhub"));
    if (!(process.env.PATH || "").split(":").includes(lb)) console.log("  Add ~/.local/bin to your PATH.");
  }
  console.log(`SubHub ${VERSION}: installed (${launcher()})`);
  migrate();
  console.log("Finding your AI accounts…");
  const reg = await refresh();
  for (const s of reg.subs) console.log(`  ${s.name.padEnd(10)} ${s.email} · ${s.label} (${s.state})`);
  console.log("Connecting agents…"); for (const a of AGENTS) connect(a, rules);
  console.log("Done. Start a new session in any connected agent and ask it to use your subs.");
}
async function cmdSignin(args) {
  const inherit = (bin, a, env) => spawnSync(prep(bin, a).cmd, prep(bin, a).args, { ...prep(bin, a).opts, env, stdio: "inherit" });
  if (args[0] === "claude" && args[1] === "--new") {
    const email = args.includes("--email") ? args[args.indexOf("--email") + 1] : "";
    const reg = loadReg(), n = nextName(reg, "claude"), d = path.join(SH, "accounts", n); fs.mkdirSync(d, { recursive: true });
    console.log(`Signing a new Claude account in to ${d}. Pick the organization (personal or team) in the browser.`);
    inherit(binFor("claude") || die(127, "Claude Code isn't installed."), ["auth", "login", ...(email ? ["--email", email] : []), ...(args.includes("--sso") ? ["--sso"] : [])], envFor("claude", d));
    await refresh(); return;
  }
  const s = loadReg().subs.find((x) => x.name === args[0]) || die(2, `unknown sub '${args[0]}'.`);
  const b = binFor(s.provider) || die(127, `${s.name}'s CLI isn't installed.`);
  console.log(`Sign in as ${s.email}.`);
  if (s.provider === "claude") inherit(b, ["auth", "login", "--email", s.email], envFor("claude", s.dir));
  else if (s.provider === "codex") inherit(b, ["login"], envFor("codex", s.dir));
  else if (s.provider === "cursor") inherit(b, ["login"]);
  else if (s.provider === "gemini") inherit(b, []);
  else console.log("Ollama has no sign-in (cloud models: run `ollama signin`).");
  await refresh();
}
function cmdRemove(name) {
  const reg = loadReg(), s = reg.subs.find((x) => x.name === name) || die(2, `unknown sub '${name}'.`);
  fs.appendFileSync(IGN, `${s.provider}:${s.dir}\n`); reg.subs = reg.subs.filter((x) => x !== s); saveReg(reg);
  console.log(`Removed ${name}. Its sign-in stays; SubHub won't add it back. Undo: delete that line from ${IGN}.`);
}
function cmdOnOff(on, name) {
  if (!loadReg().subs.some((x) => x.name === name)) die(2, `unknown sub '${name}'.`);
  const c = cfg(); c.subs ||= {}; c.subs[name] ||= {}; c.subs[name].on = on; c.order ||= []; writeJSON(CFG, c);
  console.log(`${name} is ${on ? "on" : "off"}.`);
}

// ---------------------------------------------------------------- main
const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((x) => x.startsWith("--")), words = rest.filter((x) => !x.startsWith("--"));
const withRules = !flags.includes("--no-rules") && !process.env.SUBHUB_NO_RULES;
const target = (x) => (x === "all" || !x ? AGENTS : AGENTS.includes(x) ? [x] : die(2, `unknown agent '${x}': claude, codex, gemini, cursor or all.`));
switch (cmd) {
  case "list": await cmdList(rest.includes("--refresh")); break;
  case "models": await cmdModels(rest[0]); break;
  case "ask": await cmdAsk(rest); break;
  case "status": await cmdStatus(rest); break;
  case "refresh": await refresh(); console.log("Refreshed."); break;
  case "install": await cmdInstall(withRules); break;
  case "connect": for (const a of target(words[0])) connect(a, withRules); break;
  case "disconnect": for (const a of target(words[0])) disconnect(a); break;
  case "signin": await cmdSignin(rest); break;
  case "remove": cmdRemove(rest[0]); break;
  case "on": case "off": cmdOnOff(cmd === "on", rest[0]); break;
  case "config": console.log(`${CFG}:\n` + (pexist(CFG) ? fs.readFileSync(CFG, "utf8") : '(none yet: {"subs":{"<sub>":{"on":true,"use_for":"","model":"default","notes":""}},"order":[]})')); break;
  case "ollama": await cmdOllama(rest); break;
  case "version": case "--version": console.log(`subhub ${VERSION}`); break;
  default: console.log(fs.readFileSync(SELF, "utf8").split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
