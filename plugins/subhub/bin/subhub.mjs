#!/usr/bin/env node
// SubHub: lets any AI agent on this computer hand work to your other AI subscriptions ("subs").
// One file, Node.js 18+ built-ins only, macOS / Linux / Windows. No daemon: it finds every signed-in AI
// account, keeps a small registry, and runs a sub on request. https://github.com/PrimeNexes/SubHub · MIT
//
//   subhub list [--refresh]            the ready subs, what each is for, its limits and models (agents read this);
//                                      --refresh also re-tests every sub, like check
//   subhub check [sub…] [--json]       which subs actually work: free CLI checks (auth, rate limits), then one tiny test
//                                      prompt per sub where those can't tell (costs a little usage; only check, install
//                                      and list --refresh ever do this). ask learns it from every real run for free
//   subhub models <sub>                every model that sub offers
//   subhub ask [--bg] [--force] [--in <folder>] <sub> <model|default> [brief | --brief-file <file> | brief on stdin]
//                                      (--force: try a sub known to be at its limit or out of credits anyway)
//   subhub ask [--bg] --continue <job> [--model M] [brief]   a follow-up in the same sub conversation
//   subhub jobs [--json] · subhub job <id> [--json] · subhub job tail <id> [n] · subhub job result <id>
//   subhub job wait <id> [seconds] · subhub job stop <id>      every ask is a job in ~/.subhub/jobs/<id>/
//   subhub status [--json] [--refresh] subs and their health, agents, found accounts, engine version drift
//   subhub install [--no-rules] [--no-check]   put subhub on PATH, connect every installed agent, check the subs
//   subhub connect|disconnect <agent|all> [--no-rules]   claude, codex, gemini (Antigravity), cursor
//                                      (connect adds an always-on rule to the agent's global rules file; SUBHUB_NO_RULES=1 skips it)
//   subhub signin <sub> | signin claude --new [--email you@x.com] [--sso]   sign an account in (interactive)
//   subhub remove <sub> · subhub on|off <sub> · subhub config · subhub refresh · subhub version
//   subhub ollama [--model M] [task]   a local Ollama model as an agent that can use your other subs
//
// ask exit codes: 0 answer · 2 bad sub, model, folder or job · 3 loop guard · 4 empty answer · 6 that sub is you
// 7 not signed in / app not running · 8 turned off · 9 known to be at its usage limit or out of credits (--force tries anyway)
// 10 signed in as another account · 11 can't continue that job
// 12 stalled (no activity for SUBHUB_IDLE seconds) · 13 stopped · 14 still running (job wait/result) · 124 timeout · 127 CLI missing
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.6.0-alpha";
const WIN = process.platform === "win32", MAC = process.platform === "darwin";
const HOME = os.homedir();
const SH = path.join(HOME, ".subhub"), REG = path.join(SH, "registry.json"), CFG = path.join(SH, "config.json");
const IGN = path.join(SH, "ignored"), CACHE = path.join(SH, "cache"), JOBS = path.join(SH, "jobs"), BIN = path.join(SH, "bin");
const SELF = fileURLToPath(import.meta.url);
const SRC = path.resolve(path.dirname(SELF), "..");              // the plugin folder this file came with
const PROVIDERS = ["claude", "codex", "cursor", "gemini", "ollama"];
for (const d of [SH, CACHE, JOBS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

// ---------------------------------------------------------------- helpers
const die = (code, msg) => { process.stderr.write(`SubHub: ${msg}\n`); process.exit(code); };
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.t`; fs.writeFileSync(t, JSON.stringify(o, null, 2) + "\n"); fs.renameSync(t, f); };
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
// health (signed in is not the same as working): { state: working|limit|nocredits|noauth|failing, reason, checked, resets, via }
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
      else { if (old.state !== "ok" && old.health?.state === "noauth") delete old.health; Object.assign(old, { label: w.label, state: "ok" }); }   // signed in again: try it again
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
  for (const s of loadReg().subs) {   // health an ask recorded while this ran (the CLI checks above take seconds) wins
    const o = reg.subs.find((x) => x.name === s.name);
    if (o && s.health && (!o.health || s.health.checked > o.health.checked)) o.health = s.health;
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

// ---------------------------------------------------------------- health: which signed-in subs can actually do work
// Learned from every real ask (free), and refreshed only by `subhub check`, `subhub list --refresh` and `subhub install`,
// which run free CLI checks first and one tiny test prompt only where those can't prove the sub works.
const HEALTH_WORDS = { working: "working", limit: "at its usage limit", nocredits: "out of credits or no plan", noauth: "not authorised for headless runs", failing: "failing", unknown: "unknown" };
const RETRY = { limit: 3600000, failing: 1800000 };   // a limit with no reset time, or an unrecognised failure, counts as unknown again after this
/** A sub's health now: a limit (or used-up credits) whose reset time has passed, or an old failure, is unknown again, so it gets tried. */
function healthOf(s, now = Date.now()) {
  const h = s?.health; if (!h || !HEALTH_WORDS[h.state] || h.state === "unknown") return { state: "unknown", reason: "", checked: h?.checked || 0, resets: null };
  const until = h.state === "limit" ? h.resets || h.checked + RETRY.limit : h.state === "failing" ? h.checked + RETRY.failing : h.state === "nocredits" ? h.resets || 0 : 0;
  if (until && until <= now) return { ...h, state: "unknown", was: h.state, resets: null, reason: h.state === "failing" ? `failed at ${when(h.checked)}; not tried since` : `its limit reset at ${when(until)}; not tried since` };
  return h;
}
const usable = (h) => h.state === "working" || h.state === "unknown";
/** Known not to work right now, so `subhub ask` fails fast (exit 9) instead of starting the CLI. */
const blocked = (h, now = Date.now()) => h.state === "nocredits" || (h.state === "limit" && !!h.resets && h.resets > now);
const when = (ms) => { const d = new Date(ms), hm = d.toTimeString().slice(0, 5); return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`; };
const healthLine = (h) => `${HEALTH_WORDS[h.state]}${h.resets && h.state !== "unknown" ? ` until ${when(h.resets)}` : ""}${h.reason ? `: ${clip(h.reason, 110)}` : ""}`;
const mkHealth = (h, via) => ({ state: h.state, reason: clip(h.reason || "", 200), checked: Date.now(), resets: h.resets || null, via });
function setHealth(name, h, via) {
  if (h.state === "unknown") return;
  const reg = loadReg(), s = reg.subs.find((x) => x.name === name); if (!s) return;
  s.health = mkHealth(h, via); saveReg(reg);
}

// Each CLI's own wording for "can't work right now", as [state, pattern]; the first match wins, provider rows before the common ones.
// Sources: vendor docs and issue trackers (README, "Which subs actually work"). Loose and case-insensitive on purpose; add rows here.
const HEALTH_PATTERNS = {
  claude: [["limit", /usage limit reached|hit your (\w+ )?limit|(session|weekly|5-hour|opus|sonnet) limit reached|out of extra usage|limit will reset|rate_limit_error/i],
    ["nocredits", /credit balance is too low|extra usage (is )?(disabled|not enabled|off)|no active subscription|subscription (has )?(expired|ended|lapsed|been cancell?ed|inactive)/i],
    ["noauth", /not logged in|please run \/login|invalid api key|oauth token (has )?(expired|been revoked|revoked)|authentication_error|invalid bearer token/i]],
  codex: [["limit", /hit your usage limit|usage ?limit ?(reached|exceeded)|usageLimitExceeded|exceeded the rate limit|rate limit reached/i],
    ["nocredits", /insufficient_quota|exceeded your current quota|check your plan and billing|upgrade to \w+ to continue|no credits (left|remaining)/i],
    ["noauth", /not logged in|codex login|token could not be refreshed|refresh token|401 unauthorized|unauthorized|sign in again/i]],
  cursor: [["noauth", /authentication required|stored authentication is invalid|authentication error|not (logged|signed) in|(agent|cursor-agent) login|please log ?in/i],
    ["limit", /hit your usage limit|usage limit|usage_limit_exceeded|rate limit/i],
    ["nocredits", /out of (credits|usage|requests)|on-demand usage (is )?(required|disabled|off)|upgrade to (pro|ultra|business)|subscription (has )?(expired|ended|inactive)/i]],
  gemini: [["failing", /model_capacity_exhausted|no capacity available|high demand/i],
    ["limit", /exhausted your capacity|quota will reset|individual quota reached|quota (exceeded|exhausted)|resource_exhausted|rate limit|\b429\b/i],
    ["noauth", /unauthenticated|not (signed|logged) in|sign in (again|to continue)|login required|permission_denied/i],
    ["nocredits", /no (active )?(subscription|plan)|subscription (has )?(expired|ended)|requires a (paid )?(plan|subscription)/i]],
  ollama: [["nocredits", /requires a subscription|upgrade (your plan|to)|\b403\b|insufficient balance/i],
    ["limit", /usage limit|rate limit|\b429\b|too many requests/i],
    ["noauth", /\b401\b|unauthori[sz]ed|ollama signin/i]],
  common: [["nocredits", /payment required|\b402\b|insufficient (credits|funds|balance)|out of credits|billing/i],
    ["limit", /usage limit|rate[ _-]?limit|too many requests|quota/i],
    ["noauth", /unauthori[sz]ed|authentication (required|failed)|not (logged|signed) in|log ?in again/i]],
};
// An answer (exit 0) that is only one of these is a limit message, not an answer (some CLIs print it as the reply).
const LIMIT_REPLY = /usage limit reached|hit your (\w+ )?(usage )?limit|out of extra usage|exhausted your capacity|quota will reset/i;
const MON = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
/** Minutes a time zone is ahead of UTC at a moment, or null for an unknown zone. */
function tzOffset(tz, at) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at).filter((x) => x.type !== "literal").map((x) => [x.type, +x.value]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60000);
  } catch { return null; }
}
/** The reset time a limit message names: an epoch ("limit reached|1717300000"), an ISO time, "in 2 hours 5 minutes" / "after 2h30m",
 * or a wall-clock time ("resets 9:40pm (Europe/London)", "try again at Apr 30th, 2026 11:21 AM"). null if none. */
function parseReset(text, now = Date.now()) {
  const t = String(text || "");
  let m = t.match(/limit reached\|(\d{10,13})/i) || t.match(/"?resets?_?at"?\s*[:=]\s*"?(\d{10,13})\b/i);
  if (m) return +m[1] < 1e12 ? +m[1] * 1000 : +m[1];
  m = t.match(/(?:resets?|retry|try again|until)\D{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i);
  if (m && Date.parse(m[1]) > now) return Date.parse(m[1]);
  m = t.match(/(?:try again|resets?|retry|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])[\s,]*(?:and\s+)?)+)/i);
  if (m) { let ms = 0; for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += +n * { d: 86400, h: 3600, m: 60, s: 1 }[u.toLowerCase()] * 1000; if (ms) return now + Math.round(ms); }
  m = t.match(/(?:resets?(?:\s+at)?|try again at|until|available again at)\s+(?:on\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s*)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:\(([^)]+)\)|\b(UTC|GMT)\b)?/i);
  if (m && (m[5] || m[6])) {
    const pm = /^p/i.test(m[6] || ""), h = m[6] ? (+m[4] % 12) + (pm ? 12 : 0) : +m[4], mi = +(m[5] || 0);
    if (h > 23 || mi > 59 || (m[1] && MON.indexOf(m[1].toLowerCase()) < 0)) return null;
    const tz = m[7] || m[8], off = (tz && tzOffset(tz.trim(), now)) ?? -new Date(now).getTimezoneOffset();
    const wall = new Date(now + off * 60000);   // now on that zone's clock, read with getUTC*
    const y = m[3] ? +m[3] : wall.getUTCFullYear(), mo = m[1] ? MON.indexOf(m[1].toLowerCase()) : wall.getUTCMonth(), d = m[2] ? +m[2] : wall.getUTCDate();
    let at = Date.UTC(y, mo, d, h, mi) - off * 60000;
    if (!m[1] && at <= now) at += 86400000;
    else if (m[1] && !m[3] && at < now - 86400000) at = Date.UTC(y + 1, mo, d, h, mi) - off * 60000;
    return at;
  }
  return null;
}
const lineAt = (s, i) => clip(s.slice(s.lastIndexOf("\n", i) + 1, (s.indexOf("\n", i) + 1 || s.length + 1) - 1).replace(/^\d\d:\d\d:\d\d /, "").replace(/^(error|tool error): /i, ""), 160);
/** Health from one run's outcome: exit code, the answer, and the error text (stderr, error lines). probe: a test prompt that asked for PONG. */
function classify(p, { code, answer = "", text = "" }, probe = false) {
  const a = String(answer).trim(), rows = [...(HEALTH_PATTERNS[p] || []), ...HEALTH_PATTERNS.common];
  const hit = (s) => { for (const [state, re] of rows) { const m = re.exec(s); if (m) return { state, line: lineAt(s, m.index) }; } return null; };
  const as = (f, s) => ({ state: f.state, reason: f.line, resets: ["limit", "nocredits"].includes(f.state) ? parseReset(f.line) ?? parseReset(s) : null });
  if (code === 0 && a) {
    if (a.length < 300 && LIMIT_REPLY.test(a) && !(probe && /\bpong\b/i.test(a))) { const f = hit(a); if (f && f.state !== "failing") return as(f, a); }
    return { state: "working", reason: probe ? (/\bpong\b/i.test(a) ? "answered a test prompt" : `answered a test prompt (unexpected reply: ${clip(a, 60)})`) : "answered a task" };
  }
  const all = `${a}\n${text}`, f = hit(all);
  if (f) return as(f, all);
  if (code === 124) return { state: "failing", reason: "no answer before the time limit" };
  const last = String(text).split("\n").map((l) => l.replace(/^\d\d:\d\d:\d\d /, "").trim()).filter(Boolean).pop() || a.split("\n").pop();
  return { state: "failing", reason: clip(last || (code === 4 ? "empty answer" : `exit ${code}`), 160) };
}
/** What a finished job said, for classify(). */
function outcome(j) {
  const err = jtext(j.id, "stderr.log").trim().slice(-3000);
  const prog = jtext(j.id, "progress.log").split("\n").filter((l) => /error|retry|limit|quota|couldn't start/i.test(l)).slice(-5).join("\n");
  return { code: j.code, answer: jtext(j.id, "answer.txt"), text: `${prog}\n${err}` };
}
/** Passive learning after every real ask: a normal answer marks the sub working, a limit/credits/auth failure marks it so. */
function learn(j) {
  if (!j || j.probe || [12, 13, 124].includes(j.code)) return;   // stalled, stopped, out of time: says nothing about the account
  try { setHealth(j.sub, classify(j.provider, outcome(j)), "ask"); } catch {}
}

// ---------------------------------------------------------------- check: free CLI checks first, a tiny test prompt only where needed
const PROBE = "Reply with exactly one word: PONG. Don't use any tools.", PROBE_SECS = 75;
/** Codex: `codex login status`, then `codex app-server` (stdio JSON-RPC) account/read and account/rateLimits/read. No prompt, no usage. */
function codexLimits(bin, dir) {
  return new Promise((resolve) => {
    const p = prep(bin, ["app-server"]), got = {}; let buf = "", done = false, c;
    const end = (v) => { if (done) return; done = true; clearTimeout(t); if (c?.pid) killTree(c.pid); resolve(v); };
    const t = setTimeout(() => end(sum()), 20000);
    const send = (o) => { try { c.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    const sum = () => {
      const a = got[1]?.result, rl = got[2]?.result;
      if (a && !a.account && a.requiresOpenaiAuth) return { state: "noauth", reason: "codex app-server: no account signed in" };
      if (!rl) return null;
      const buckets = Object.values(rl.rateLimitsByLimitId || {}).concat(rl.rateLimitsByLimitId ? [] : [rl.rateLimits]).filter((b) => b && typeof b === "object");
      const win = (w) => !w.windowDurationMins ? "window" : w.windowDurationMins >= 10080 ? "weekly" : w.windowDurationMins % 60 ? `${w.windowDurationMins}-minute` : `${w.windowDurationMins / 60}h`;
      let hit = null; const used = [];
      for (const b of buckets) {
        const ws = ["primary", "secondary"].map((k) => [k, b[k]]).filter(([, w]) => w && typeof w.usedPercent === "number");
        if ((b.limitId || "codex") === "codex" || b === buckets[0]) for (const [, w] of ws) used.push(`${win(w)} ${Math.round(w.usedPercent)}% used`);
        let full = ws.filter(([, w]) => w.usedPercent >= 100);   // the windows used up; if only the server's flag says so, the one it names (else primary)
        if (!full.length && b.rateLimitReachedType) full = ws.filter(([k]) => k === b.rateLimitReachedType).concat(ws.filter(([k]) => k === "primary")).slice(0, 1);
        for (const [, w] of full) { const r = w.resetsAt ? w.resetsAt * 1000 : null; if (!hit || (r || 0) > (hit.resets || 0)) hit = { state: "limit", reason: `codex rate limits: ${win(w)} limit${b.limitId && b.limitId !== "codex" ? ` (${b.limitId})` : ""} used up${b.rateLimitReachedType ? ` (${b.rateLimitReachedType})` : ""}`, resets: r }; }
      }
      if (hit) return hit;
      if (!used.length) return null;
      return { state: "working", reason: `codex rate limits OK (${[...new Set(used)].join(", ")}${a?.account?.planType ? `; plan ${a.account.planType}` : ""}), no prompt sent` };
    };
    try { c = spawn(p.cmd, p.args, { ...p.opts, env: envFor("codex", dir), stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: !WIN }); } catch { return end(null); }
    c.on("error", () => end(null)); c.on("close", () => end(sum())); c.stdin.on("error", () => {});
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(l); } catch { continue; }
        if (m?.id === 0) { send({ method: "initialized", params: {} }); send({ method: "account/read", id: 1, params: { refreshToken: false } }); send({ method: "account/rateLimits/read", id: 2 }); }
        else if (m?.id === 1 || m?.id === 2) { got[m.id] = m; if (got[1] && got[2]) end(sum()); }
      }
    });
    send({ method: "initialize", id: 0, params: { clientInfo: { name: "subhub", title: "SubHub", version: VERSION } } });
  });
}
/** Ollama Cloud: GET https://ollama.com/api/balance with OLLAMA_API_KEY (docs.ollama.com/api/balance). */
async function ollamaBalance() {
  try {
    const r = await fetch("https://ollama.com/api/balance", { headers: { Authorization: "Bearer " + process.env.OLLAMA_API_KEY }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401) return { state: "noauth", reason: "ollama.com refused OLLAMA_API_KEY (401)" };
    if (r.status === 403) return { state: "nocredits", reason: "ollama.com: account suspended (403)" };
    if (!r.ok) return null;
    const d = await r.json(), inc = d?.included || {};
    for (const k of ["session", "weekly"]) if (inc[k] && inc[k].remaining_percent <= 0) return { state: "limit", reason: `Ollama cloud ${k} limit used up`, resets: Date.parse(inc[k].resets_at) || null };
    if (typeof inc.balance_usd === "number" && inc.balance_usd <= 0 && !(d.purchased?.balance_usd > 0)) return { state: "nocredits", reason: "Ollama cloud credits used up", resets: Date.parse(inc.period?.until) || null };
    return { state: "working", reason: "ollama.com balance OK, no prompt sent" };
  } catch { return null; }
}
/** Layer 1: what the CLI itself can prove for free (refresh() has already run `claude auth status`, `cursor-agent status`
 * and `--list-models`, `agy models`, and Ollama's /api/tags). null: it can't prove the sub works, so a test prompt is needed. */
async function freeCheck(s) {
  if (s.provider === "ollama") {
    const ms = readJSON(path.join(CACHE, "ollama-models.json")) || [], tasks = ms.filter((m) => m.caps.includes("completion") || !m.caps.includes("embedding"));
    if (tasks.some((m) => !m.cloud)) return { state: "working", reason: `Ollama is running with ${tasks.filter((m) => !m.cloud).length} local model(s); no prompt sent` };
    if (!tasks.length) return { state: "failing", reason: "Ollama has no model that can do tasks; pull one yourself (SubHub never downloads models)" };
    return process.env.OLLAMA_API_KEY ? ollamaBalance() : null;   // cloud models only
  }
  const bin = binFor(s.provider); if (!bin) return { state: "failing", reason: `${BINARY[s.provider]} isn't installed` };
  if (s.provider === "codex") {
    const r = run(bin, ["login", "status"], { env: envFor("codex", s.dir), timeout: 30000 });
    if (r.code !== 0) return { state: "noauth", reason: `codex login status: ${clip((r.out + r.err).trim().split("\n").pop() || "not logged in", 100)}` };
    return codexLimits(bin, s.dir);
  }
  return null;
}
/** The cheapest, fastest model a sub offers, for the test prompt. */
function probeModel(s) {
  const cache = (f) => { try { return fs.readFileSync(path.join(CACHE, f), "utf8"); } catch { return ""; } };
  if (s.provider === "claude") return "haiku";
  if (s.provider === "cursor") return "auto";
  if (s.provider === "gemini") { const ids = cache("gemini-models.txt").split("\n").map((l) => l.split("\t")[0]).filter(Boolean); return ids.find((i) => /flash.*lite/.test(i)) || ids.find((i) => /flash.*low/.test(i)) || ids.find((i) => /flash/.test(i)) || "default"; }
  if (s.provider === "codex") { let j; try { j = JSON.parse(run(binFor("codex"), ["debug", "models"], { env: envFor("codex", s.dir) }).out); } catch {} return (j?.models || []).filter((m) => m.visibility === "list").map((m) => m.slug).find((x) => /mini|nano|spark/.test(x)) || "default"; }
  const ms = readJSON(path.join(CACHE, "ollama-models.json")) || []; return (ms.find((m) => !m.caps.includes("embedding") || m.caps.includes("completion")))?.name || "default";
}
/** Layer 2: one headless test prompt through the normal ask path (same account, env, pins and flags), in an empty temp folder. */
function probe(s) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subhub-probe-")), model = probeModel(s);
    const c = spawn(process.execPath, [SELF, "ask", "--force", "--in", dir, s.name, model, PROBE], { cwd: dir, env: { ...process.env, SUBHUB_PROBE: "1", SUBHUB_TIMEOUT: String(PROBE_SECS) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => {
      const id = err.match(/job ([0-9a-f]{6})/)?.[1], j = id ? jget(id) : null, last = clip(err.trim().split("\n").pop()?.replace(/^SubHub: /, "") || `exit ${code}`, 160);
      let h;
      if (!j) h = code === 3 ? { state: "unknown", reason: "can't test from inside a sub" } : [7, 10].includes(code) ? { state: "noauth", reason: last } : { state: "failing", reason: last };   // refused before it ran
      else h = classify(s.provider, { ...outcome(j), answer: out.trim() || jtext(id, "answer.txt") }, true);
      if (id) fs.rmSync(path.join(JOBS, id), { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ ...h, model });
    });
  });
}
/** Checks every sub (or the named ones) in parallel, stores the health, returns one row per sub. */
async function checkSubs(names = []) {
  const reg = await refresh();
  for (const n of names) if (!reg.subs.some((s) => s.name === n)) die(2, `unknown sub '${n}'. subhub list shows them.`);
  const rows = await Promise.all((names.length ? reg.subs.filter((s) => names.includes(s.name)) : reg.subs).map(async (s) => {
    const row = { name: s.name, provider: s.provider, account: s.email, result: "", reason: "", resets: null, how: "not checked" };
    const skip = (result, reason) => Object.assign(row, { result, reason });
    if (!names.includes(s.name) && !isOn(s.name)) return skip("off", "turned off by the user");
    if (s.state === "signedout") return skip("signedout", `signed out (subhub signin ${s.name})`);
    if (s.state.startsWith("changed:")) return skip("changed", `signed in as ${s.state.slice(8)}, not ${s.email} (subhub signin ${s.name})`);
    if (s.state === "stopped") return skip("stopped", "Ollama isn't running (SubHub never starts it)");
    const me = isCaller(s); if (me) return skip("you", `this is you (${me}), not checked`);
    let h = await freeCheck(s), how = "free check";
    if (!h) { h = await probe(s); how = `test prompt, model ${h.model}`; }
    return Object.assign(row, { result: h.state, reason: h.reason, resets: h.resets || null, how, health: h.state === "unknown" ? null : h });
  }));
  const r2 = loadReg();
  for (const row of rows) { const s = r2.subs.find((x) => x.name === row.name); if (s && row.health) s.health = mkHealth(row.health, "check"); delete row.health; }
  saveReg(r2);
  return rows;
}
function printChecks(rows) {
  const word = (r) => HEALTH_WORDS[r.result] || { off: "off", signedout: "signed out", changed: "signed in as someone else", stopped: "not running", you: "this is you" }[r.result] || r.result;
  console.log(`${"Sub".padEnd(10)} ${"Account".padEnd(26)} ${"Result".padEnd(32)} ${"Resets".padEnd(13)} Reason`);
  for (const r of rows) console.log(`${r.name.padEnd(10)} ${clip(r.account, 26).padEnd(26)} ${word(r).padEnd(32)} ${(r.resets ? when(r.resets) : "").padEnd(13)} ${r.reason}${r.how !== "not checked" ? ` [${r.how}]` : ""}`);
}
async function cmdCheck(args) {
  const rows = await checkSubs(args.filter((a) => !a.startsWith("--")));
  if (args.includes("--json")) { console.log(JSON.stringify({ version: VERSION, checked: Date.now(), subs: rows })); return; }
  printChecks(rows);
}

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
  if (force) await checkSubs();   // --refresh: also re-tests every sub (free checks, then a tiny test prompt where needed)
  const reg = await fresh(false); const out = [], now = Date.now();
  out.push("# Your subs (from SubHub)", "", "Run one with `subhub ask <sub> <model|default>` and the brief (see the subhub skill). Never pick the account you are running as.", "",
    "| Sub | Account | Use it for | Can do, and limits |", "|---|---|---|---|");
  const ready = [], off = [], waiting = [], stale = [];
  for (const s of ranked(reg)) {
    if (!isOn(s.name)) { off.push(s.name); continue; }
    if (s.state === "signedout") { waiting.push(`${s.name} (signed out)`); continue; }
    if (s.state.startsWith("changed:")) { waiting.push(`${s.name} (signed in as ${s.state.slice(8)}, not ${s.email})`); continue; }
    if (s.state === "stopped") { waiting.push(`${s.name} (Ollama isn't running)`); continue; }
    const h = healthOf(s, now), age = h.checked ? now - h.checked : 0;
    if (!usable(h)) { waiting.push(`${s.name} (${healthLine(h)}${age > 3600000 ? `; seen ${ago(age)} ago` : ""})`); continue; }
    if (h.state === "working" && age > 3 * 86400000) stale.push(`${s.name} ${ago(age)} ago`);
    out.push(`| ${s.name} | ${s.email}, ${s.label} | ${pref(s.name, "use_for") || USE_FOR[s.provider]} | ${LIMITS[s.provider]} |`); ready.push(s);
  }
  if (stale.length) out.push("", `Last seen working: ${stale.join(", ")}.`);
  out.push("", "All subs start fresh (no memory of your conversation), run headless (they can't ask questions), with full access and no approval prompts, in the folder you call from (or `--in <folder>`), for up to 30 minutes (stopped early as stalled after 15 minutes with no activity).",
    "", "Every ask is a job: `subhub ask --bg …` returns a job id at once; `subhub job wait <id>` collects it, `subhub job <id>` shows its progress, and `subhub ask --continue <id> <follow-up>` continues the same conversation (also after a timeout or stall).",
    "", "## Models", "", "Pass an id as the 2nd argument, or default. Quote ids with brackets.");
  let firstClaude = null;
  for (const s of ready) {
    const m = pref(s.name, "model");
    if (s.provider === "claude") { if (m) out.push("", `**${s.name}**: the user picked \`${m}\`: pass default unless the task needs another.`); firstClaude ||= s; continue; }
    out.push("", `**${s.name}**${m ? ` (the user picked \`${m}\`: pass default unless the task needs another)` : ""}`, ...models(s, true));
  }
  if (firstClaude) out.push("", `**Every Claude sub** (${ready.filter((s) => s.provider === "claude").map((s) => s.name).join(", ")})`, ...models(firstClaude, true));
  if (off.length) out.push("", `Turned off by the user, don't use: ${off.join(", ")}`);
  if (waiting.length) out.push("", `Not ready, don't use: ${waiting.join(", ")}. The user fixes sign-ins with \`subhub status\` and re-tests subs with \`subhub check\`.`);
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
  const f = found(reg), h = hookCfg(), hook = { on: h.on, types: h.types, loaded: claudePlugin() }, eng = engines();
  if (args.includes("--json")) {
    console.log(JSON.stringify({ version: VERSION, engine: eng, subs: reg.subs.map((s) => { const hh = healthOf(s); return { name: s.name, provider: s.provider, folder: s.dir, email: s.email, label: s.label, state: s.state, on: isOn(s.name),
      health: { state: hh.state, reason: hh.reason || "", checked: hh.checked || null, resets: hh.resets || null, via: s.health?.via || null, usable: usable(hh) } }; }), agents, hook, found: f }));
    return;
  }
  for (const w of eng.drift) console.log(`Warning: ${w}`);
  console.log("Subs:");
  for (const s of reg.subs) {
    const hh = healthOf(s), seen = hh.checked ? ` (seen ${ago(Date.now() - hh.checked)} ago)` : "";
    console.log(`  ${s.name.padEnd(10)} ${s.email.padEnd(28)} ${s.label.padEnd(26)} ${isOn(s.name) ? s.state : "off"}${s.state === "ok" ? `, ${hh.state === "unknown" && !hh.reason ? "not checked yet" : healthLine(hh) + seen}` : ""}`);
  }
  console.log("Agents:"); for (const a of agents) console.log(`  ${a.name.padEnd(12)} ${!a.installed ? "not installed" : a.connected ? "connected" : `not connected (subhub connect ${a.id})`}${a.rules ? `, always-on rule in ${a.rulesFile}` : ""}`);
  console.log(`Claude Code redirect hook: ${hook.on ? "on" : "off"} (${hook.types.map((t) => t || "no type").join(", ") || "no types"} → ${RELAY}; "hook": false in ${CFG} or SUBHUB_HOOK=0 turns it off)${hook.loaded ? "" : ". The relay agent and the hook load only with the plugin installed through Claude Code's plugin manager, which it isn't"}`);
  if (f.length) { console.log("Found, not signed in (subhub signin claude --new --email <email>):"); for (const x of f) console.log(`  ${x.email} · ${["team", "enterprise"].includes(x.type) ? "Team " + x.orgName : "Personal"}`); }
}

// ---------------------------------------------------------------- ask
const CALLER_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH", "CLAUDE_CODE_SDK_HAS_SESSIONS_OAUTH_REFRESH", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE"];
/** Whether a Claude sub is the account the calling Claude Code session runs as (from that session's environment): why, or "". */
function isCaller(s, env = process.env, inClaude = !!env.CLAUDECODE) {
  if (s.provider !== "claude") return "";
  const caller = env.CLAUDE_CODE_USER_EMAIL ? `${env.CLAUDE_CODE_USER_EMAIL.toLowerCase()}|${env.CLAUDE_CODE_ORGANIZATION_UUID || ""}` : "";
  if (caller && caller === `${s.email}|${s.org}`) return "the account you're running as";
  if (inClaude && real(env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude")) === real(s.dir || path.join(HOME, ".claude"))) return "the Claude account you're running as";
  return "";
}
const readStdin = () => { try { return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8"); } catch { return ""; } };
function gitSnap(cwd) {
  const st = run("git", ["status", "--porcelain", "-uall"], { cwd }); if (st.code !== 0) return null;
  return crypto.createHash("sha1").update(st.out + run("git", ["diff"], { cwd }).out).digest("hex");
}

// Every brief gets this: in a headless run nobody collects background work, and the run would wait on it.
const FOREGROUND = "Run every command in the foreground and wait for it to finish. Never start background tasks, background agents or processes that keep running (servers, watchers): nobody collects them in a headless run, and the run would hang.";
const IDLE = 900;   // default SUBHUB_IDLE: longer than one long command (Claude's Bash tool caps a command at 10 minutes)

async function cmdAsk(argv) {
  const args = [...argv], opt = {};
  for (const f of ["--in", "--brief-file", "--continue", "--model"]) { const i = args.indexOf(f); if (i >= 0) { opt[f] = args[i + 1]; args.splice(i, 2); } }
  const bg = args.indexOf("--bg"); if (bg >= 0) args.splice(bg, 1);
  const fi = args.indexOf("--force"), force = fi >= 0; if (force) args.splice(fi, 1);
  let parent = null, name, model, task;
  if (opt["--continue"]) {
    parent = jload(opt["--continue"]) || die(2, `no job '${opt["--continue"]}'. subhub jobs lists them.`);
    const w = whyNot(parent); if (w) die(11, `job ${parent.id} can't be continued: ${w}.`);
    try { process.chdir(parent.folder); } catch { die(2, `can't open the folder '${parent.folder}' that job ${parent.id} ran in.`); }
    [name, model, task = ""] = [parent.sub, opt["--model"] || parent.model, args[0]];
  } else {
    if (opt["--in"]) { try { process.chdir(expand(opt["--in"])); } catch { die(2, `can't open the folder '${opt["--in"]}'.`); } }
    [name, model = "default", task = ""] = args; if (opt["--model"]) model = opt["--model"];
  }
  if (!task) task = opt["--brief-file"] ? fs.readFileSync(expand(opt["--brief-file"]), "utf8") : readStdin();
  // Who is calling: a Claude Code session says so in its environment (isCaller). Any agent may call.
  const env = { ...process.env }, isProbe = !!env.SUBHUB_PROBE;
  for (const v of [...CALLER_VARS, "SUBHUB_PROBE"]) delete env[v];          // a sub uses its own sign-in, never the caller's
  const max = +env.SUBHUB_MAX_DEPTH || 1, depth = +env.SUBHUB_DEPTH || 0;
  if (depth >= max) die(3, `loop guard: depth ${max} reached`);
  env.SUBHUB_DEPTH = String(depth + 1);
  let reg = loadReg(), s = reg.subs.find((x) => x.name === name);
  if (!s) { reg = await refresh(); s = reg.subs.find((x) => x.name === name); }
  if (!s) die(2, `unknown sub '${name}'. subhub list shows them.`);
  if (!isOn(name)) die(8, `${name} is turned off.`);
  if (s.state === "signedout") die(7, `${name} is signed out. Sign it in with: subhub signin ${name}`);
  if (s.state.startsWith("changed:")) die(10, `${name} isn't signed in as ${s.email} any more (it's ${s.state.slice(8)}). Sign it in again: subhub signin ${name}`);
  if (s.state === "stopped") die(7, "Ollama isn't running. Start it yourself; SubHub never starts it.");
  const h = healthOf(s);
  if (blocked(h) && !force) die(9, `${name} is ${healthLine(h)} (seen ${ago(Date.now() - h.checked)} ago). Don't retry it: pick another sub. To try it anyway: subhub ask --force …`);
  if (model === "default" && pref(name, "model")) model = pref(name, "model");
  if (!/^[A-Za-z0-9._:/\[\]-]+$/.test(model)) die(2, `'${model}' isn't a model name.`);
  const cwd = process.cwd(), notes = pref(name, "notes");
  const all = typeof cfg().notes === "string" ? cfg().notes.trim() : "";   // top-level notes: every sub, every brief
  let brief;
  if (parent) brief = `Follow-up from the AI agent that gave you the task. Same folder (${cwd}); you still run headless, so nobody can answer questions. ${FOREGROUND}\n`
    + (task.trim() || "Carry on with the task from where you stopped and finish it. If you change any files, list them at the end.");
  else {
    brief = `Task from another AI agent. You're its sub-agent, working in ${cwd}. You run headless: nobody can answer questions, so make sensible choices and finish. ${FOREGROUND} If you change any files, list them at the end.\n${task}`;
    if (notes) brief += `\n\nNotes from the user for this sub:\n${notes}`;
  }
  if (all) brief += `\n\nNotes from the user for every sub:\n${all}`;
  brief += "\n\nYou are a sub-agent. Do not delegate further.";
  const idle = env.SUBHUB_IDLE !== undefined && env.SUBHUB_IDLE !== "" ? Math.max(0, +env.SUBHUB_IDLE || 0) : IDLE;
  const job = { id: "", sub: name, provider: s.provider, model, folder: cwd, started: Date.now(), state: "running", code: null, pid: null,
    session: parent?.session || null, resume: parent?.session || null, parent: parent?.id || null,
    title: clip(task.split("\n").find((l) => l.trim()) || "(carry on)", 70), timeout: +env.SUBHUB_TIMEOUT || 1800, idle, bg: bg >= 0, ...(isProbe ? { probe: true } : {}) };
  if (s.provider === "ollama") {
    if (model === "default") model = ollamaDefault(reg);
    if (!model) die(7, "Ollama has no models. Pull one yourself (ollama pull <model>); SubHub never downloads models.");
    const tags = await ollamaModels(); if (!tags) die(7, `Ollama isn't running at ${ollamaHost()}. Start it yourself; SubHub never starts it.`);
    if (!model.includes(":")) model += ":latest";
    if (!tags.some((m) => m.name === model)) die(7, `${model} isn't installed in Ollama, and SubHub won't download it.`);
    job.model = model;
  } else {
    const bin = binFor(s.provider) || die(127, `${name}'s CLI isn't installed.`);
    if (s.provider === "claude") {
      const me = isCaller(s); if (me) die(6, `${name} is ${me}. Pick another sub.`);
      const w = claudeWho(bin, s.dir); if (!w || `${w.email}|${w.org}` !== `${s.email}|${s.org}`) die(10, `${name} isn't signed in as ${s.email} any more. Sign it in again: subhub signin ${name}`);
      Object.assign(env, envFor("claude", s.dir, env)); delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
      env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";   // documented: no background commands or agents for a headless sub
    } else if (s.provider === "codex") { Object.assign(env, envFor("codex", s.dir, env)); if (!s.dir) delete env.CODEX_HOME; }
    const c = caps(s.provider, bin);
    if (parent && !c.resume) die(11, `job ${parent.id} can't be continued: ${BINARY[s.provider]} on this computer has no resume option.`);
    Object.assign(job, { bin, stream: c.stream && !env.SUBHUB_PLAIN, settings: !!c.settings });
  }
  prune();
  do job.id = crypto.randomBytes(3).toString("hex"); while (pexist(jf(job.id, "")));
  fs.mkdirSync(path.join(JOBS, job.id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(jf(job.id, "brief.txt"), brief); writeJSON(jf(job.id), job);
  if (job.bg) {   // a detached runner (this file again) does the work and outlives the caller
    spawn(process.execPath, [SELF, "_run", job.id], { cwd, env, detached: true, stdio: "ignore", windowsHide: true }).unref();
    console.log(`SubHub: started job ${job.id} (${name}, model ${job.model}) in ${cwd}.\nCollect it: subhub job wait ${job.id} 600 · progress: subhub job ${job.id} · stop: subhub job stop ${job.id}`);
    process.exit(0);
  }
  process.stderr.write(`SubHub: job ${job.id} (progress: subhub job ${job.id})\n`);
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  const j = await execJob(job.id);
  if (j.code !== 0) process.stderr.write(failNote(j));
  const answer = jtext(j.id, "answer.txt"), changes = jtext(j.id, "changes.txt");
  if (answer) console.log(answer);
  if (changes) console.log("\n" + changes);
  process.exit(j.code);
}

// ---------------------------------------------------------------- jobs: ~/.subhub/jobs/<id>/ job.json brief.txt progress.log stdout.log stderr.log answer.txt
const jf = (id, f = "job.json") => path.join(JOBS, id, f);
const jget = (id) => /^[\w-]+$/.test(id || "") ? readJSON(jf(id)) : null;
const jset = (id, o) => { const j = { ...jget(id), ...o }; writeJSON(jf(id), j); return j; };
const jtext = (id, f) => { try { return fs.readFileSync(jf(id, f), "utf8"); } catch { return ""; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`; };
const clip = (v, n = 120) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
/** The most telling argument of a tool call, trimmed. */
function argOf(o) {
  if (!o || typeof o !== "object") return clip(o);
  for (const k of ["command", "cmd", "CommandLine", "file_path", "path", "AbsolutePath", "TargetFile", "pattern", "query", "url", "Url", "description", "prompt"]) if (o[k]) return clip(o[k]);
  const v = Object.values(o).find((x) => typeof x === "string"); return clip(v ?? JSON.stringify(o));
}
/** Stops a process and everything it started (its process group; taskkill /T on Windows). */
function killTree(pid, sig = "SIGTERM") {
  if (!pid) return;
  if (WIN) { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); return; }
  const k = (g) => { try { process.kill(-pid, g); } catch { try { process.kill(pid, g); } catch {} } };
  k(sig); if (sig !== "SIGKILL") setTimeout(() => k("SIGKILL"), 5000).unref();
}
/** A job as it really is: one marked running whose runner is gone (reboot, kill -9) becomes interrupted. */
function jload(id) {
  const j = jget(id); if (!j) return null;
  if (j.state === "running") {
    const dead = j.pid ? !alive(j.pid) : Date.now() - j.started > 60000, over = Date.now() - j.started > (j.timeout + 300) * 1000;
    if (dead || over) {   // its sub CLI may outlive it: SubHub won't kill a pid it can't be sure of (after a reboot pids are reused)
      return jset(id, { state: "interrupted", code: 1, ended: Date.now(), child: null, note: dead ? "Its runner process ended without recording a result (reboot, crash or kill)." : "It ran past its time limit." });
    }
  }
  return j;
}
/** Why a job can't be continued, or "" if it can. */
function whyNot(j) {
  if (j.state === "running") return "it is still running (subhub job wait or subhub job stop it first)";
  if (j.provider === "ollama") return pexist(jf(j.id, "history.json")) ? "" : "no conversation was saved";
  return j.session ? "" : `no session id was captured from ${j.sub}${j.stream === false ? " (its CLI ran in plain mode, without a stream)" : ""}`;
}
function prune() {   // jobs older than SUBHUB_JOB_DAYS (7) go
  const lim = Date.now() - (+process.env.SUBHUB_JOB_DAYS || 7) * 86400000;
  for (const id of ls(JOBS)) {
    const j = jget(id); let t = j ? j.ended || j.started : 0;
    if (!t) try { t = fs.statSync(path.join(JOBS, id)).mtimeMs; } catch {}
    if (t < lim && (!j || j.state !== "running" || !alive(j.pid))) fs.rmSync(path.join(JOBS, id), { recursive: true, force: true });
  }
}
/** Appends timestamped progress lines; an exact repeat of the last line isn't written and doesn't count as activity. */
function progressLog(id) {
  let last = "", reps = 0;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return (text) => {
    const t = clip(text, 240); if (!t) return false;
    if (t === last) { reps++; return false; }
    fs.appendFileSync(jf(id, "progress.log"), (reps ? `${stamp()} (the line before repeated ${reps} more times)\n` : "") + `${stamp()} ${t}\n`);
    last = t; reps = 0; return true;
  };
}
function failNote(j) {
  const w = whyNot(j), how = w ? `It can't be continued: ${w}.` : `Continue it: subhub ask --continue ${j.id} "<what to do next>"`;
  const head = j.state === "timeout" ? `${j.sub} timed out after ${j.timeout} seconds` : j.state === "stalled" ? `${j.sub} showed no activity for ${j.idle} seconds and was stopped as stalled`
    : j.state === "stopped" ? `${j.sub} was stopped` : `${j.sub} failed (exit ${j.code})`;
  const tail = jtext(j.id, "progress.log").trim().split("\n").slice(-5).join("\n");
  return `SubHub: ${head} (job ${j.id}). ${how}\nLast progress lines:\n${tail}\n`;
}
function describe(j, n = 5) {
  const now = Date.now(), prog = jtext(j.id, "progress.log").trimEnd().split("\n").filter(Boolean), w = whyNot(j);
  const out = [`Job ${j.id}: ${j.state === "running" || j.state === "done" ? j.state : `${j.state} (exit ${j.code})`} · ${j.sub}, model ${j.model} · in ${j.folder}`,
    `Started ${new Date(j.started).toLocaleString()} · ${j.state === "running" ? "running for" : "ran for"} ${ago((j.ended || now) - j.started)} · last activity ${ago(now - (j.active || j.started))} ago`];
  if (j.parent) out.push(`Follow-up to job ${j.parent}.`);
  if (j.note) out.push(j.note);
  if (j.state === "running") out.push(`Wait: subhub job wait ${j.id} 600 · stop: subhub job stop ${j.id} · ${j.session || j.provider === "ollama" ? "can be continued once it ends" : "no session id yet"}`);
  else out.push(`Answer: subhub job result ${j.id} · ${w ? `can't be continued: ${w}` : `continue: subhub ask --continue ${j.id} "<follow-up>"`}`);
  out.push(prog.length ? "Last progress:" : "No progress yet.", ...prog.slice(-n).map((l) => "  " + l));
  return out.join("\n");
}

// ---------------------------------------------------------------- each CLI's headless stream, from its docs; gated on its --help
// claude -p --output-format stream-json --verbose, --resume <session_id>  (code.claude.com/docs/en/headless)
// codex exec --json, codex exec resume <thread_id>                         (developers.openai.com/codex/noninteractive)
// cursor-agent -p --output-format stream-json, --resume <session_id>       (cursor.com/docs/cli/reference/output-format)
// agy -p --output-format stream-json, --conversation <conversation_id>     (antigravity.google/docs/cli/headless)
const AGY_SETTINGS = '{"toolPermission":"always-proceed","allowNonWorkspaceAccess":true}';
function caps(p, bin) {
  let st = {}; try { st = fs.statSync(bin); } catch {}
  const key = `${bin}|${st.size}|${st.mtimeMs}`, f = path.join(CACHE, `help-${p}.json`), c = readJSON(f);
  if (c?.key === key) return c;
  const h = run(bin, p === "codex" ? ["exec", "--help"] : ["--help"], { timeout: 30000 }), t = h.out + h.err;
  const has = (re) => re.test(t);
  const o = { key, stream: has({ claude: /stream-json/, codex: /--json\b/, cursor: /stream-json/, gemini: /stream-json/ }[p]),
    resume: has({ claude: /--resume\b/, codex: /\bresume\b/, cursor: /--resume\b/, gemini: /--conversation\b/ }[p]), settings: p === "gemini" && has(/--settings\b/) };
  if (t.trim()) writeJSON(f, o);
  return o;
}
function cliArgs(j, brief) {
  const m = j.model !== "default" ? ["--model", j.model] : [], sid = j.resume, sj = j.stream;
  let a, input;
  if (j.provider === "claude") a = ["-p", ...(sj ? ["--output-format", "stream-json", "--verbose"] : []), ...(sid ? ["--resume", sid] : []), "--permission-mode", "bypassPermissions", "--settings", '{"disableAllHooks":true}', ...m, brief];
  else if (j.provider === "codex") a = sid ? ["exec", "resume", ...(sj ? ["--json"] : []), "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", ...m, sid, brief]
    : ["exec", ...(sj ? ["--json"] : []), "--sandbox", "danger-full-access", "--skip-git-repo-check", "-c", 'approval_policy="never"', ...m, brief];
  else if (j.provider === "cursor") a = ["--force", "--sandbox", "disabled", "--trust", "--approve-mcps", ...(sj ? ["--output-format", "stream-json"] : []), ...(sid ? ["--resume", sid] : []), ...m, "-p", brief];
  else a = ["--dangerously-skip-permissions", ...(j.settings ? ["--settings", AGY_SETTINGS] : []), ...(sj ? ["--output-format", "stream-json"] : []), ...(sid ? ["--conversation", sid] : []), ...m, "-p", brief];
  if (isShim(j.bin)) {   // cmd.exe can't carry line breaks in an argument
    const i = a.lastIndexOf(brief);
    if (j.provider === "claude") { a.splice(i, 1); input = brief; }
    else if (j.provider === "codex") { a[i] = "-"; input = brief; }
    else a[i] = brief.replace(/\r?\n+/g, " ");
  }
  return { args: a, input };
}
/** Turns one stream event into progress lines, the session id and the answer (r collects them). */
const PARSE = {
  claude(e, r) {
    if (e.session_id) r.session ||= e.session_id;
    const sub = e.parent_tool_use_id ? "(subagent) " : "";
    if (e.type === "system" && e.subtype === "init") r.log(`started${e.model ? " on " + e.model : ""}`);
    else if (e.type === "system" && e.subtype === "api_retry") r.log(`API retry ${e.attempt}/${e.max_retries}: ${e.error}`);
    else if (e.type === "assistant") for (const b of e.message?.content || []) {
      if (b.type === "text" && b.text?.trim()) { if (!sub) r.text = b.text; r.log(`${sub}says: ${clip(b.text)}`); }
      else if (b.type === "tool_use") r.log(`${sub}${b.name} ${argOf(b.input)}`);
    }
    else if (e.type === "user") { for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b.type === "tool_result" && b.is_error) r.log(`${sub}tool error: ${clip(typeof b.content === "string" ? b.content : JSON.stringify(b.content))}`); }
    else if (e.type === "result") { r.answer = e.result ?? r.text; r.error = !!e.is_error; r.log(`finished: ${e.subtype || (e.is_error ? "error" : "success")}`); }
  },
  codex(e, r) {
    if (e.type === "thread.started") { r.session ||= e.thread_id; r.log("started"); }
    else if (e.type === "item.started" || e.type === "item.completed") {
      const it = e.item || {}, done = e.type === "item.completed";
      if (it.type === "agent_message" && done) { r.text = it.text || ""; r.log(`says: ${clip(it.text)}`); }
      else if (it.type === "command_execution") r.log(done ? `ran (exit ${it.exit_code ?? "?"}): ${clip(it.command)}` : `run: ${clip(it.command)}`);
      else if (it.type === "file_change" && done) r.log(`edit: ${clip((it.changes || []).map((c) => `${c.kind || ""} ${c.path}`).join(", "))}`);
      else if (it.type === "mcp_tool_call" && !done) r.log(`tool ${it.server}.${it.tool}`);
      else if (it.type === "web_search" && !done) r.log(`search: ${clip(it.query)}`);
      else if (it.type === "reasoning" && done) r.log(`thinking: ${clip(it.text, 80)}`);
      else if (it.type === "error") r.log(`error: ${clip(it.message)}`);
    }
    else if (e.type === "turn.failed") { r.error = true; r.log(`error: ${clip(e.error?.message)}`); }
    else if (e.type === "error") r.log(`error: ${clip(e.message)}`);
    else if (e.type === "turn.completed") { r.answer = r.text; r.log("finished"); }
  },
  cursor(e, r) {
    if (e.session_id) r.session ||= e.session_id;
    if (e.type === "system" && e.subtype === "init") r.log(`started${e.model ? " on " + e.model : ""}`);
    else if (e.type === "assistant") { const t = (e.message?.content || []).map((b) => b.text || "").join(""); if (t.trim()) { r.text = t; r.log(`says: ${clip(t)}`); } }
    else if (e.type === "tool_call") {
      const k = Object.keys(e.tool_call || {})[0], v = (k && e.tool_call[k]) || {};
      let a = v.args ?? v.arguments; if (typeof a === "string") { try { a = JSON.parse(a); } catch {} }
      if (e.subtype === "started") r.log(`${k === "function" ? v.name : String(k || "tool").replace(/ToolCall$/, "")} ${argOf(a)}`);
      else if (v.result?.error || v.result?.failure) r.log(`tool error: ${clip(JSON.stringify(v.result.error || v.result.failure))}`);
    }
    else if (e.type === "result") { r.answer = e.result ?? r.text; r.error = !!e.is_error; r.log(`finished: ${e.subtype || "?"}`); }
  },
  gemini(e, r) {
    const u = e.step_update || e.init || e.result || {};
    if (e.conversation_id || u.conversation_id) r.session ||= e.conversation_id || u.conversation_id;
    if (e.event === "init") r.log(`started (${u.permission_mode || "?"})`);
    else if (e.event === "step_update") {
      const k = String(u.step_index);
      if (u.tool_info && !r.seen.has(k)) { r.seen.add(k); r.log(`${u.tool_info.name} ${argOf(u.tool_info.parameters)}`); }
      else if (u.subagent_info && !r.seen.has(k)) { r.seen.add(k); r.log(`subagent: ${argOf(u.subagent_info)}`); }
      else if (u.step_type === "agent_response") {
        const b = r.buf[k] || "", d = u.text_delta || "";
        if (u.state === "ACTIVE") r.buf[k] = b + d;
        else { const t = b && d.startsWith(b) ? d : b + d; if (t.trim()) { r.text = t; r.log(`says: ${clip(t)}`); } }
      }
    }
    else if (e.event === "result") { r.answer = u.response ?? r.text; r.error = !!u.status && u.status !== "SUCCESS"; r.log(`finished: ${u.status || "?"}`); }
  },
};

/** Runs one job to the end (in the foreground ask, or in the detached runner) and records the outcome. */
async function execJob(id) {
  const j = jget(id), brief = jtext(id, "brief.txt"), say = progressLog(id), t0 = Date.now();
  let active = t0, saved = t0, why = "", child = null, reject = null, answer = "", code = 0;
  const r = { session: null, text: "", answer: null, error: false, seen: new Set(), buf: {}, log: (t) => { if (say(t)) active = Date.now(); } };
  jset(id, { pid: process.pid, active });
  const before = gitSnap(j.folder);
  const stop = (w) => { if (why) return; why = w; if (child) killTree(child.pid); reject?.(Object.assign(new Error(w), { why: w })); };
  const onSig = () => stop("stopped"); const SIGS = WIN ? ["SIGINT"] : ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const g of SIGS) process.on(g, onSig);
  const tick = setInterval(() => {
    const now = Date.now();
    if (pexist(jf(id, "stop"))) stop("stopped");
    else if (j.idle && now - active > j.idle * 1000) stop("stalled");
    else if (now - t0 > j.timeout * 1000) stop("timeout");
    if (active !== saved) { saved = active; jset(id, { active }); }
  }, 1000);
  const guard = new Promise((_, rej) => (reject = rej)); guard.catch(() => {});
  try {
    if (j.provider === "ollama") {
      const hist = j.parent ? readJSON(jf(j.parent, "history.json")) : null;
      r.log(`started on ${j.model}${hist ? " with the earlier conversation" : ""}`);
      const res = await Promise.race([ollamaAgent(j.model, brief, false, hist, { log: r.log, save: (h) => writeJSON(jf(id, "history.json"), h), stopped: () => !!why }), guard]);
      answer = res.answer; r.log("finished");
    } else {
      const { args, input } = cliArgs(j, brief), parse = j.stream ? PARSE[j.provider] : null;
      const raw = fs.createWriteStream(jf(id, "stdout.log")), errf = fs.createWriteStream(jf(id, "stderr.log")), rest = { o: "", e: "" };
      let plain = "", events = 0, lastOut = null;
      const line = (l, isErr) => {
        if (isErr) return r.log(l);
        if (l !== lastOut) { active = Date.now(); lastOut = l; }
        let e = null; if (parse && l.trimStart().startsWith("{")) { try { e = JSON.parse(l); } catch {} }
        if (!e) { plain += l + "\n"; return; }
        events++; const had = r.session; try { parse(e, r); } catch {}
        if (r.session && !had) jset(id, { session: r.session });   // as early as possible: even a timed-out job can be continued
      };
      const feed = (k, isErr) => (d) => { (isErr ? errf : raw).write(d); const ls = (rest[k] + d).split(/\r?\n/); rest[k] = ls.pop(); for (const l of ls) line(l, isErr); };
      code = await new Promise((resolve) => {
        const p = prep(j.bin, args);
        child = spawn(p.cmd, p.args, { ...p.opts, cwd: j.folder, env: process.env, detached: !WIN, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
        child.on("error", (e) => { errf.write(String(e) + "\n"); r.log(`couldn't start ${j.bin}: ${e.message}`); resolve(127); });
        child.on("close", (c) => resolve(c ?? 1));
        if (child.pid) jset(id, { child: child.pid });
        if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
        child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
        child.stdout.on("data", feed("o")); child.stderr.on("data", feed("e", true));
        if (why) killTree(child.pid);
      });
      if (rest.o) line(rest.o, false); if (rest.e) line(rest.e, true);
      raw.end(); errf.end();
      if (parse && !events && plain.trim()) r.log("no stream events: read the output as plain text");
      answer = parse && events ? (r.answer ?? r.text) || (r.text || plain) : plain;
      if (r.error && code === 0) code = 1;
    }
  } catch (e) { if (!e.why) { code = 1; r.log(`error: ${e.message}`); fs.appendFileSync(jf(id, "stderr.log"), String(e.stack || e) + "\n"); } }
  clearInterval(tick); for (const g of SIGS) process.off(g, onSig);
  if (!why && pexist(jf(id, "stop"))) why = "stopped";   // subhub job stop may kill the CLI before the next tick sees its note
  answer = String(answer || "").trim();
  code = { timeout: 124, stalled: 12, stopped: 13 }[why] ?? (code === 0 && !answer ? 4 : code);
  if (why) say(why === "timeout" ? `timed out after ${j.timeout}s` : why === "stalled" ? `no activity for ${j.idle}s: stopped as stalled` : "stopped");
  let changes = "";
  if (before && before !== gitSnap(j.folder)) changes = `SubHub: files in ${j.folder} that changed while ${j.sub} ran (git status; includes anything else working here):\n${run("git", ["status", "--porcelain", "-uall"], { cwd: j.folder }).out.trimEnd()}`;
  fs.writeFileSync(jf(id, "answer.txt"), answer); if (changes) fs.writeFileSync(jf(id, "changes.txt"), changes);
  const fin = jset(id, { state: why === "timeout" ? "timeout" : why || (code === 0 ? "done" : "failed"), code, ended: Date.now(), active, session: r.session || j.session || null, child: null });
  learn(fin);   // passive learning: every real ask updates the sub's health, for free
  return fin;
}

async function cmdJobs(args) {
  prune();
  const all = ls(JOBS).map(jload).filter((j) => j && !j.probe).sort((a, b) => b.started - a.started).filter((j, i) => j.state === "running" || i < 20), now = Date.now();
  if (args.includes("--json")) { console.log(JSON.stringify(all.map((j) => ({ ...j, sinceActivity: now - (j.active || j.started), continuable: !whyNot(j) })))); return; }
  if (!all.length) { console.log("No jobs yet."); return; }
  for (const j of all) console.log(`${j.id}  ${j.state.padEnd(11)} ${j.sub.padEnd(10)} ${(ago(now - j.started) + " ago").padEnd(10)} ${j.state === "running" ? `active ${ago(now - (j.active || j.started))} ago  ` : ""}${j.title || ""}`);
}
async function cmdJob(args) {
  const verb = ["tail", "result", "wait", "stop"].includes(args[0]) ? args[0] : "show", id = verb === "show" ? args[0] : args[1];
  if (!id) die(2, "name a job, for example: subhub job a1b2c3 (subhub jobs lists them)");
  let j = jload(id) || die(2, `no job '${id}'. subhub jobs lists them.`);
  const result = () => {
    if (j.code !== 0) process.stderr.write(failNote(j));
    const a = jtext(id, "answer.txt"), c = jtext(id, "changes.txt");
    if (a) console.log(a); if (c) console.log("\n" + c);
    process.exit(j.code ?? 1);
  };
  if (verb === "show") console.log(args.includes("--json") ? JSON.stringify({ ...j, sinceActivity: Date.now() - (j.active || j.started), continuable: !whyNot(j) }) : describe(j));
  else if (verb === "tail") console.log(jtext(id, "progress.log").trimEnd().split("\n").slice(-(+args[2] || 20)).join("\n"));
  else if (verb === "result") { if (j.state === "running") { console.log(describe(j)); process.exit(14); } result(); }
  else if (verb === "wait") {
    const until = Date.now() + (args[2] === undefined ? 600 : Math.max(0, +args[2] || 0)) * 1000;
    while (j.state === "running" && Date.now() < until) { await sleep(Math.min(1000, Math.max(50, until - Date.now()))); j = jload(id); }
    if (j.state === "running") { console.log(describe(j)); process.exit(14); }
    result();
  } else {
    if (j.state !== "running") { console.log(`Job ${id} isn't running (${j.state}).`); return; }
    fs.writeFileSync(jf(id, "stop"), String(Date.now()));
    if (j.child) killTree(j.child);
    for (let i = 0; i < 40 && j.state === "running"; i++) { await sleep(250); j = jget(id); }
    if (j.state === "running") { killTree(j.child, "SIGKILL"); killTree(j.pid, "SIGKILL"); j = jset(id, { state: "stopped", code: 13, ended: Date.now(), child: null }); }
    const w = whyNot(j);
    console.log(`Stopped job ${id}. ${w ? `It can't be continued: ${w}.` : `Continue it: subhub ask --continue ${id} "<what to do next>"`}`);
  }
}

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
async function ollamaAgent(model, task, driver, history = null, hooks = {}) {   // hooks: log(progress line), save(history), stopped()
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
  hooks.save?.(history);
  for (let i = 0; i < (+process.env.SUBHUB_OLLAMA_STEPS || 40); i++) {
    if (hooks.stopped?.()) throw Object.assign(new Error("stopped"), { why: "stopped" });
    hooks.log?.(`asking ${model} (step ${i + 1})`);
    const out = (await oapi("/api/chat", req)).message || {};
    history.push({ role: "assistant", content: out.content || "", ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) });
    hooks.save?.(history);
    if (!out.tool_calls?.length) { hooks.log?.(`says: ${clip(out.content)}`); return { answer: (out.content || "").trim(), history }; }
    for (const c of out.tool_calls) {
      const name = c.function?.name; let a = c.function?.arguments || {};
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = {}; } }
      hooks.log?.(`${name} ${argOf(a)}`);
      let result; try { result = tools[name] ? await tools[name][0](a) : `no tool named ${name}`; } catch (e) { result = `error: ${e.message}`; }
      if (/^(error|no tool)/.test(String(result))) hooks.log?.(`${name}: ${clip(result)}`);
      if (process.env.SUBHUB_OLLAMA_VERBOSE) process.stderr.write(`· ${name} ${JSON.stringify(a).slice(0, 120)}\n`);
      history.push({ role: "tool", tool_name: name, content: String(result).slice(0, 30000) });
    }
    hooks.save?.(history);
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
/** Claude Code has SubHub through its plugin manager (so the relay agent and the redirect hook load), not only the skills-folder copy. */
const claudePlugin = () => JSON.stringify(readJSON(path.join(HOME, ".claude", "plugins", "installed_plugins.json")) || "").includes('"subhub@');
function agentOn(a) {
  if (a === "claude") return claudePlugin() || pexist(path.join(HOME, ".claude", "skills", "subhub", "bin", "subhub.mjs"));
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
  "- Before starting a built-in sub-agent, or doing delegable side work (wide file reads, research, reviews, independent edits, parallel pieces), hand the work to a ready sub with `subhub ask` (details in the subhub skill). This saves this account's usage. Run `subhub list` once per task, not before every step.",
  "- Do it yourself or with built-in sub-agents only when `subhub list` shows no ready sub, the task is a few tool calls, the work needs this conversation's context that can't be put in a brief, or the brief would have to contain secrets.",
  "- If a sub fails, stalls or reports a usage limit, try one other sub once, then do the work yourself. Never retry the same sub in a loop.",
  "- If you are running as a sub yourself (the brief says you are a sub-agent, or SUBHUB_DEPTH is set), don't delegate.",
  "- Run `subhub` as the whole command, with nothing chained before or after it.",
  RULE_END];
const RULE_CLAUDE = "- In Claude Code, delegate with the Agent tool and subagent_type `subhub:relay` (it passes your prompt to a sub and returns the answer), not general-purpose or Explore.";
/** The block for one agent: Claude Code with the plugin installed (so the relay agent exists) also gets the relay line. */
const ruleBlock = (a) => a === "claude" && claudePlugin() ? [...RULE_BLOCK.slice(0, 3), RULE_CLAUDE, ...RULE_BLOCK.slice(3)] : RULE_BLOCK;
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
function addRules(file, a) {
  const old = readText(file), text = old ?? "", eol = text.includes("\r\n") ? "\r\n" : "\n", block = ruleBlock(a).join(eol), at = findBlock(text);
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
  else if (rules) { const f = RULE_FILES[a]()[0]; addRules(f, a); note = `; always-on rule in ${f}`; }
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
async function cmdInstall(rules, check = true) {
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
  if (check) {
    console.log("Checking which subs actually work: free CLI checks first, then one tiny test prompt (a one-word reply) per sub where those can't tell. This uses a little of those subs' usage; skip it with --no-check.");
    printChecks(await checkSubs());
  } else console.log("Skipped checking which subs work (--no-check). Run `subhub check` any time.");
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

// ---------------------------------------------------------------- engine copies: `subhub` on PATH (~/.subhub/bin) and the plugin copies agents load
/** The VERSION in an engine file (read from its first 16 KB), or null. */
function versionIn(file) {
  try { const fd = fs.openSync(file, "r"), b = Buffer.alloc(16384), n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString("utf8", 0, n).match(/^const VERSION = "([^"]+)"/m)?.[1] || null; } catch { return null; }
}
const vnum = (v) => String(v || "").split(/[^\d]+/).filter(Boolean).slice(0, 3).map(Number);
const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
/** This engine, the one on PATH, and Claude Code's plugin copies; drift: a warning per mismatch, naming the fix. */
function engines() {
  const inst = path.join(BIN, "subhub.mjs"), installed = versionIn(inst), copies = [{ where: SELF, version: VERSION }];
  const ip = readJSON(path.join(HOME, ".claude", "plugins", "installed_plugins.json"))?.plugins?.["subhub@subhub"];
  for (const e of Array.isArray(ip) ? ip : []) {
    const f = e?.installPath ? path.join(e.installPath, "bin", "subhub.mjs") : null, v = (f && versionIn(f)) || e?.version;
    if (v && f && real(f) !== real(SELF)) copies.push({ where: f, version: v, plugin: "Claude Code" });
  }
  const drift = [], best = copies.reduce((a, b) => (newer(b.version, a.version) ? b : a), copies[0]);
  const fix = `run \`subhub install\` from the newest copy: node "${newer(best.version, installed) || !installed ? best.where : inst}" install`;
  if (!installed) drift.push(`subhub isn't installed in ${BIN}, so agents can't run it (the Claude Code redirect hook stays off). Fix: ${fix}`);
  else for (const c of copies) if (c.version !== installed && real(c.where) !== real(inst))
    drift.push(`${c.plugin ? `Claude Code's SubHub plugin (${c.where})` : `This engine (${c.where})`} is ${c.version}, but \`subhub\` on PATH (${inst}) is ${installed}; the relay agent and the hook expect the same version (the hook stays off until they match). Fix: ${fix}`);
  return { running: VERSION, path: SELF, installed, copies, drift };
}

// ---------------------------------------------------------------- Claude Code redirect hook (plugin hooks/hooks.json: PreToolUse on Agent|Task)
// `subhub hook pretool` reads the hook JSON on stdin. When Claude is about to start a generic built-in sub-agent and a sub is
// ready, it denies that call once with a pointer to the relay agent; the same call again (same session and prompt) goes ahead.
// Anything else, or any error, prints nothing: the call goes ahead. Reads only registry.json, config.json and the VERSION line of
// ~/.subhub/bin/subhub.mjs (a sub counts only if its stored health is working or unknown): no spawns, no network.
const RELAY = "subhub:relay", HOOK_TYPES = ["general-purpose", "Explore", "claude", ""], HOOK_STATE = path.join(SH, "hook-denied.json");
/** Whether the redirect hook is on (config "hook": false or SUBHUB_HOOK=0 turn it off) and the agent types it redirects ("hook_types"; "" = no type). */
function hookCfg(c = cfg()) {
  const e = process.env.SUBHUB_HOOK;
  return { on: e !== undefined && e !== "" ? !/^(0|off|false|no)$/i.test(e) : c.hook !== false,
    types: Array.isArray(c.hook_types) ? c.hook_types.filter((t) => typeof t === "string") : HOOK_TYPES };
}
const HOOK_REASON = "SubHub: hand this to one of the user's other AI subscriptions instead, to save this account's usage. "
  + `Call the Agent tool again with subagent_type "${RELAY}" and the same prompt; it relays the prompt verbatim to a ready sub and returns the answer and a job id. `
  + "To pick the sub, make the prompt's first line `use: <sub> [model]` (`subhub list` shows them); for a follow-up, `continue: <job id>`. "
  + "If the task needs this conversation's context or secrets, or the relay failed, repeat this exact call: it will be allowed.";
function cmdHook(args) {
  try {
    if (args[0] !== "pretool" || process.env.SUBHUB_DEPTH) return;   // inside a sub: never redirect
    const c = readJSON(CFG) || {}, h = hookCfg(c); if (!h.on) return;
    const inp = JSON.parse(readStdin()), ti = inp?.tool_input;
    if (!["Agent", "Task"].includes(inp?.tool_name) || !ti || typeof ti !== "object") return;
    if (ti.subagent_type != null && typeof ti.subagent_type !== "string") return;   // a shape this hook doesn't know
    const type = (ti.subagent_type || "").trim();
    if (type === RELAY || !h.types.some((t) => t.trim().toLowerCase() === type.toLowerCase())) return;
    if (versionIn(path.join(BIN, "subhub.mjs")) !== VERSION) return;   // `subhub` on PATH is missing or another version: the relay couldn't work
    const subs = readJSON(REG)?.subs; if (!Array.isArray(subs)) return;
    if (!subs.some((s) => s && c.subs?.[s.name]?.on !== false && s.state === "ok" && usable(healthOf(s)) && !isCaller(s, process.env, true))) return;
    const key = crypto.createHash("sha1").update(`${inp.session_id || ""}\0${typeof ti.prompt === "string" ? ti.prompt : JSON.stringify(ti.prompt ?? "")}`).digest("hex");
    const now = Date.now(), old = readJSON(HOOK_STATE), st = {};
    for (const [k, t] of Object.entries(old && typeof old === "object" ? old : {})) if (typeof t === "number" && now - t < 86400000) st[k] = t;   // a day
    const again = !!st[key]; if (!again) st[key] = now;
    const tmp = `${HOOK_STATE}.${process.pid}.t`; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, HOOK_STATE);
    if (again) return;   // denied once already: the escape hatch, so there's never a deny loop
    fs.writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: HOOK_REASON } }) + "\n");
  } catch {}
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
  case "jobs": await cmdJobs(rest); break;
  case "job": await cmdJob(rest); break;
  case "_run": { let j; try { j = await execJob(rest[0]); } catch (e) { j = jset(rest[0], { state: "failed", code: 1, ended: Date.now(), note: String(e.message || e) }); } process.exit(j.code ?? 1); }
  case "status": await cmdStatus(rest); break;
  case "refresh": await refresh(); console.log("Refreshed."); break;
  case "install": await cmdInstall(withRules, !flags.includes("--no-check") && !process.env.SUBHUB_NO_CHECK); break;
  case "check": await cmdCheck(rest); break;
  case "connect": for (const a of target(words[0])) connect(a, withRules); break;
  case "disconnect": for (const a of target(words[0])) disconnect(a); break;
  case "signin": await cmdSignin(rest); break;
  case "remove": cmdRemove(rest[0]); break;
  case "on": case "off": cmdOnOff(cmd === "on", rest[0]); break;
  case "config": console.log(`${CFG}:\n` + (pexist(CFG) ? fs.readFileSync(CFG, "utf8") : '(none yet: {"subs":{"<sub>":{"on":true,"use_for":"","model":"default","notes":""}},"order":[],"notes":"","hook":true})')); break;
  case "ollama": await cmdOllama(rest); break;
  case "hook": cmdHook(rest); break;
  case "version": case "--version": console.log(`subhub ${VERSION}`); break;
  default: { const ls = fs.readFileSync(SELF, "utf8").split("\n"); console.log(ls.slice(1, ls.findIndex((l) => l.startsWith("import "))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); }
}
