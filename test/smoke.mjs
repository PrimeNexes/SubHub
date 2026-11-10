#!/usr/bin/env node
// Smoke test for the subhub engine on macOS, Linux and Windows. Runs the real engine against stand-in CLIs
// (claude, codex, cursor-agent, agy) and a stand-in Ollama server, in a throwaway home. Nothing real is touched.
//   node test/smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "plugins", "subhub", "bin", "subhub.mjs");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "subhub-smoke-"));
const BINDIR = path.join(H, ".local", "bin");
let failures = 0;
const ok = (cond, name, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); if (!cond) failures++; };
const mk = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ---------- throwaway home
const who = (dir, email, org, orgName, type) => mk(path.join(dir, "who.json"), JSON.stringify({ loggedIn: true, email, orgId: org, orgName, subscriptionType: type }));
who(path.join(H, ".claude"), "Main@x.com", "org-main", "main's Organization", "max");
who(path.join(H, ".claude-acct2"), "second@x.com", "org-second", "second's", "pro");
who(path.join(H, ".claude-team"), "main@x.com", "org-team", "Acme", "team");
who(path.join(H, ".claude-dup"), "second@x.com", "org-second", "second's", "pro");
fs.mkdirSync(path.join(H, ".claude-out"), { recursive: true });                              // signed out: skipped
mk(path.join(H, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "main@x.com", organizationUuid: "org-beta", organizationName: "Beta Corp", organizationType: "claude_team" } }));
const payload = Buffer.from(JSON.stringify({ email: "cx@x.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url");
mk(path.join(H, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: `h.${payload}.s` } }));
mk(path.join(H, ".gemini", "antigravity-cli", "log", "a.log"), "applyAuthResult: email=G@x.com, authMethod=consumer\n");
mk(path.join(H, ".cursor", "cli-config.json"), JSON.stringify({ permissions: { allow: ["Shell(ls)"], deny: [] }, version: 1 }, null, 2));
mk(path.join(H, ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ trustedWorkspaces: ["/x"] }));

// ---------- stand-in CLIs: one node script, a launcher per name
const STANDIN = path.join(H, "standin.mjs");
mk(STANDIN, `
import fs from "node:fs"; import path from "node:path";
const [tool, ...a] = process.argv.slice(2); const home = process.env.HOME || process.env.USERPROFILE;
const j = (o) => console.log(JSON.stringify(o));
if (tool === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  if (a[0] === "auth") { const f = path.join(dir, "who.json"); if (fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f)); process.exit(0); } j({ loggedIn: false }); process.exit(1); }
  if (a[0] === "plugin") process.exit(1);
  j({ tool, argv: a, dir: process.env.CLAUDE_CONFIG_DIR || "default", token: process.env.CLAUDE_CODE_OAUTH_TOKEN || "none" });
} else if (tool === "codex") {
  if (a[0] === "debug") { j({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier.", context_window: 272000, visibility: "list" }, { slug: "x", visibility: "hide" }] }); process.exit(0); }
  if (a[0] === "plugin") process.exit(1);
  j({ tool, argv: a });
} else if (tool === "cursor-agent") {
  if (a[0] === "status") { console.log("Logged in as cur@x.com\\nTeam: Acme Team (id 1)"); process.exit(0); }
  if (a[0] === "--list-models") { console.log("Available models\\n\\nauto - Auto (default)\\ngpt-5.3-codex-high - Codex 5.3 High\\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking"); process.exit(0); }
  j({ tool, argv: a });
} else if (tool === "agy") {
  if (a[0] === "models") { console.log("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)"); process.exit(0); }
  if (a[0] === "plugin") process.exit(1);
  const brief = a[a.length - 1] || "";
  if (brief.includes("SLEEP")) { setTimeout(() => {}, 600000); }
  else { if (brief.includes("EDIT")) fs.writeFileSync("made.txt", "hi"); console.log("gemini ran: " + brief.split("\\n")[1]); }
}
`);
for (const name of ["claude", "codex", "cursor-agent", "agy"]) {
  if (WIN) mk(path.join(BINDIR, name + ".cmd"), `@echo off\r\nnode "${STANDIN}" ${name} %*\r\n`);
  else { mk(path.join(BINDIR, name), `#!/bin/sh\nexec node "${STANDIN}" ${name} "$@"\n`); fs.chmodSync(path.join(BINDIR, name), 0o755); }
}

// ---------- stand-in Ollama server (Ollama's documented /api endpoints)
const chats = [];
const MODELS = { "agent:8b": [["completion", "vision", "tools", "thinking", "audio"], 131072, "8B"], "textonly:3b": [["completion"], 8192, "3B"], "big:cloud": [["completion", "tools"], 262144, "480B"] };
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const send = (o, raw) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(raw ?? JSON.stringify(o)); };
    if (req.url === "/api/tags") return send({ models: Object.keys(MODELS).map((n) => ({ name: n, ...(n.includes("cloud") ? { remote_host: "https://ollama.com" } : {}) })) });
    if (req.url === "/v1/audio/transcriptions") return send(null, "move the meeting to thursday");
    const b = JSON.parse(body || "{}");
    if (req.url === "/api/show") { const [caps, ctx, size] = MODELS[b.model]; return send({ capabilities: caps, details: { parameter_size: size }, model_info: { "general.architecture": "x", "x.context_length": ctx } }); }
    if (req.url === "/api/chat") {
      const user = b.messages.filter((m) => m.role === "user").pop(), last = b.messages[b.messages.length - 1];
      chats.push({ model: b.model, tools: (b.tools || []).map((t) => t.function.name).sort(), think: b.think, num_ctx: b.options?.num_ctx, images: (user.images || []).length, text: user.content });
      if (last.role === "tool") return send({ message: { role: "assistant", content: `DONE ${last.tool_name}: ${last.content.slice(0, 200).replace(/\n/g, " | ")}` }, done: true });
      const want = (t) => (b.tools || []).some((x) => x.function.name === t);
      if (user.content.includes("WRITEFILE") && want("write_file")) return send({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "write_file", arguments: { path: "ollama.txt", content: "hello" } } }] }, done: true });
      if (user.content.includes("HANDOFF") && want("subhub_ask")) return send({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "subhub_ask", arguments: { sub: "gemini-1", brief: "say PONG" } } }] }, done: true });
      return send({ message: { role: "assistant", content: "ANSWER " + user.content.split("\n")[1] }, done: true });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

// ---------- running the engine (async, so the stand-in server keeps answering)
const baseEnv = { ...process.env, HOME: H, USERPROFILE: H, PATH: BINDIR + path.delimiter + process.env.PATH, OLLAMA_HOST: `127.0.0.1:${server.address().port}`, SUBHUB_MARKET: ROOT };
for (const v of ["CLAUDECODE", "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_ORGANIZATION_UUID", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SUBHUB_DEPTH", "OLLAMA_API_KEY"]) delete baseEnv[v];
const sh = (args, { env = {}, input, cwd = WORK } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [ENGINE, ...args], { env: { ...baseEnv, ...env }, cwd, windowsHide: true });
  let out = "", err = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (err += d));
  if (input !== undefined) c.stdin.end(input); else c.stdin.end();
  c.on("close", (code) => resolve({ code, out, err }));
});
const WORK = path.join(H, "work"); fs.mkdirSync(WORK);
const git = (a) => spawnSync("git", a, { cwd: WORK, encoding: "utf8" });
const haveGit = git(["init", "-q"]).status === 0;
if (haveGit) { fs.writeFileSync(path.join(WORK, "a.txt"), "a"); git(["add", "."]); git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]); }

// 1. discovery
let r = await sh(["status", "--json", "--refresh"]);
let st = {}; try { st = JSON.parse(r.out); } catch {}
const subs = Object.fromEntries((st.subs || []).map((s) => [s.name, s]));
ok(subs["claude-1"]?.email === "main@x.com" && subs["claude-1"].folder === "", "default Claude sign-in is claude-1", r.out + r.err);
ok(Object.values(subs).some((s) => s.email === "second@x.com" && s.folder.endsWith(".claude-acct2")), "~/.claude-acct2 found");
ok(Object.values(subs).some((s) => s.email === "main@x.com" && /Team · Acme/.test(s.label)), "team organization on the same email is its own sub");
ok(Object.values(subs).filter((s) => s.email === "second@x.com").length === 1, "duplicate folder skipped");
ok(subs["codex-1"]?.email === "cx@x.com" && subs["cursor-1"]?.email === "cur@x.com" && subs["gemini-1"]?.email === "g@x.com", "codex, cursor, gemini found", JSON.stringify(Object.keys(subs)));
ok(subs["ollama-1"]?.state === "ok", "ollama found through its API");
ok((st.found || []).some((f) => f.orgName === "Beta Corp"), "unsigned team organization listed under found");
ok((st.agents || []).filter((a) => a.installed).length === 4, "four agents detected");

// 2. list and models
r = await sh(["list"]);
ok(r.out.includes("| claude-2 |") && r.out.includes("**Every Claude sub**"), "list has the table and Claude models");
ok(/`agent:8b`: 8B, 128K context, agent with tools, reads images, transcribes \.wav, thinks/.test(r.out), "ollama models show their capabilities", r.out.split("**ollama-1**")[1]?.slice(0, 300));
ok(/`textonly:3b`: 3B, 8K context, text only/.test(r.out) && /big:cloud.*ollama\.com/.test(r.out), "text-only and cloud models labelled");
r = await sh(["models", "codex-1"]); ok(r.out.includes("gpt-6-astra") && !r.out.includes("`x`"), "codex models from its catalog");

// 3. ask
const claude2 = Object.values(subs).find((s) => s.email === "second@x.com").name;
r = await sh(["ask", claude2, "opus", "do the thing"], { env: { CLAUDE_CODE_OAUTH_TOKEN: "leak" } });
let j = {}; try { j = JSON.parse(r.out.split("\n")[0]); } catch {}
ok(r.code === 0 && j.argv?.includes("bypassPermissions") && j.argv?.includes("opus") && j.dir.endsWith(".claude-acct2"), "ask runs the Claude sub in its own folder", r.out + r.err);
ok(j.token === "none", "caller's token is not passed to the sub");
r = await sh(["ask", claude2, "default", "hi"], { env: { CLAUDE_CODE_USER_EMAIL: "Second@x.com", CLAUDE_CODE_ORGANIZATION_UUID: "org-second" } });
ok(r.code === 6, "a session can't use its own account (exit 6)", r.err);
r = await sh(["ask", "claude-1", "default", "hi"], { env: { CLAUDECODE: "1" } });
ok(r.code === 6, "a Claude session on the default folder can't use claude-1 (exit 6)", r.err);
r = await sh(["ask", "gemini-1", "x;y", "hi"]); ok(r.code === 2, "bad model name refused (exit 2)");
r = await sh(["ask", "gemini-1", "default"], { input: "from\nSTDIN brief" }); ok(r.out.includes("gemini ran"), "brief from stdin", r.out + r.err);
fs.writeFileSync(path.join(H, "brief.txt"), "from\nFILE brief"); r = await sh(["ask", "gemini-1", "default", "--brief-file", path.join(H, "brief.txt")]); ok(r.code === 0 && r.out.includes("gemini ran"), "brief from --brief-file");
if (haveGit) { r = await sh(["ask", "gemini-1", "default", "x\nEDIT please"]); ok(/changed while gemini-1 ran[\s\S]*made\.txt/.test(r.out), "files changed in a git repo are listed", r.out); }
r = await sh(["ask", "cursor-1", "auto", "hi"]); ok(r.code === 0 && r.out.includes("cursor-agent"), "cursor sub runs");
r = await sh(["ask", "codex-1", "default", "hi"]); ok(r.code === 0 && r.out.includes("exec"), "codex sub runs");
r = await sh(["ask", "gemini-1", "default", "x\nSLEEP"], { env: { SUBHUB_TIMEOUT: "2" } }); ok(r.code === 124, "timeout stops the sub (exit 124)", `${r.code} ${r.err}`);

// 4. pins, on/off, loop guard
who(path.join(H, ".claude-acct2"), "other@x.com", "o", "other", "pro");
r = await sh(["ask", claude2, "default", "hi"]); ok(r.code === 10, "a changed sign-in stops the sub (exit 10)", r.err);
who(path.join(H, ".claude-acct2"), "second@x.com", "org-second", "second's", "pro");
await sh(["off", "gemini-1"]); r = await sh(["ask", "gemini-1", "default", "hi"]); ok(r.code === 8, "turned-off sub refused (exit 8)"); await sh(["on", "gemini-1"]);
r = await sh(["ask", "gemini-1", "default", "hi"], { env: { SUBHUB_DEPTH: "1" } }); ok(r.code === 3, "loop guard (exit 3)");

// 5. Ollama
r = await sh(["ask", "ollama-1", "agent:8b", "x\nWRITEFILE please"]); ok(r.out.includes("DONE write_file") && fs.existsSync(path.join(WORK, "ollama.txt")), "Ollama model with tools works as an agent", r.out + r.err);
fs.writeFileSync(path.join(WORK, "pic.png"), "PNG"); fs.writeFileSync(path.join(WORK, "note.wav"), "RIFF");
chats.length = 0; r = await sh(["ask", "ollama-1", "agent:8b", `x\nDescribe ${path.join(WORK, "pic.png")} and ${path.join(WORK, "note.wav")}`]);
ok(chats[0]?.images === 1 && chats[0]?.text.includes("move the meeting") && chats[0]?.think === true && chats[0]?.num_ctx === 65536, "image attached, audio transcribed, thinking on, context raised", JSON.stringify(chats[0]));
chats.length = 0; r = await sh(["ask", "ollama-1", "textonly:3b", "x\nWRITEFILE"]); ok(chats[0]?.tools.length === 0 && chats[0]?.num_ctx === 8192 && chats[0]?.think === undefined, "text-only model gets no tools", JSON.stringify(chats[0]));
chats.length = 0; await sh(["ask", "ollama-1", "agent:8b", "x\nhi"], { env: { OLLAMA_API_KEY: "k" } }); ok(chats[0]?.tools.includes("web_search"), "web search tools only with OLLAMA_API_KEY");
r = await sh(["ollama", "--model", "agent:8b", "HANDOFF to a sub"]); ok(r.out.includes("DONE subhub_ask") && r.out.includes("gemini ran"), "subhub ollama: a local model hands work to another sub", r.out + r.err);
r = await sh(["ask", "ollama-1", "nope:1b", "hi"]); ok(r.code === 7, "model that isn't installed refused (exit 7)");

// 6. agents: connect and disconnect
r = await sh(["connect", "all"]);
const cur = JSON.parse(fs.readFileSync(path.join(H, ".cursor", "cli-config.json"), "utf8"));
ok(fs.existsSync(path.join(H, ".claude", "skills", "subhub", "skills", "subhub", "SKILL.md")) && JSON.parse(fs.readFileSync(path.join(H, ".claude", "settings.json"), "utf8")).permissions.allow.includes("Bash(subhub *)"), "Claude Code connected (plugin + rule)");
ok(fs.existsSync(path.join(H, ".codex", "skills", "subhub", "SKILL.md")) && fs.readFileSync(path.join(H, ".codex", "rules", "subhub.rules"), "utf8").includes('prefix_rule(pattern = ["subhub"]'), "Codex connected (skill + rule)");
ok(fs.existsSync(path.join(H, ".gemini", "config", "skills", "subhub", "SKILL.md")) && JSON.parse(fs.readFileSync(path.join(H, ".gemini", "antigravity-cli", "settings.json"), "utf8")).permissions.allow.includes("command(subhub)"), "Antigravity connected (skill + rule)");
ok(cur.permissions.allow.includes("Shell(ls)") && cur.permissions.allow.includes("Shell(subhub)") && fs.existsSync(path.join(H, ".cursor", "skills", "subhub", "SKILL.md")), "Cursor connected, its own rules kept");
await sh(["disconnect", "all"]);
const cur2 = JSON.parse(fs.readFileSync(path.join(H, ".cursor", "cli-config.json"), "utf8"));
ok(cur2.permissions.allow.join() === "Shell(ls)" && !fs.existsSync(path.join(H, ".cursor", "skills", "subhub")) && !fs.existsSync(path.join(H, ".codex", "rules", "subhub.rules")), "disconnect removes exactly what was added");

// 7. install and remove
r = await sh(["install"], { env: { SUBHUB_REPO: ROOT } });
ok(fs.existsSync(path.join(H, ".subhub", "bin", "subhub.mjs")) && fs.existsSync(path.join(H, ".subhub", "bin", WIN ? "subhub.cmd" : "subhub")), "install puts the engine and launcher in ~/.subhub/bin", r.out + r.err);
if (!WIN) { const l = spawnSync(path.join(H, ".local", "bin", "subhub"), ["version"], { env: baseEnv, encoding: "utf8" }); ok(/subhub \d/.test(l.stdout), "~/.local/bin/subhub runs", l.stderr); }
else { const l = spawnSync("cmd.exe", ["/d", "/c", path.join(H, ".subhub", "bin", "subhub.cmd"), "version"], { env: baseEnv, encoding: "utf8" }); ok(/subhub \d/.test(l.stdout), "subhub.cmd runs", l.stderr); }
const team = Object.values(subs).find((s) => /Acme/.test(s.label)).name;
await sh(["remove", team]); r = await sh(["status", "--json", "--refresh"]); ok(!JSON.parse(r.out).subs.some((s) => s.name === team), "removed sub isn't added back");

server.close();
console.log(failures ? `\n${failures} FAILED (${process.platform})` : `\nAll passed (${process.platform}, node ${process.version})`);
if (!process.env.SUBHUB_KEEP) fs.rmSync(H, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
