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
let failures = 0; const T0 = Date.now();
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
import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process";
const [tool, ...a] = process.argv.slice(2); const home = process.env.HOME || process.env.USERPROFILE;
const j = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// --help: each CLI's documented stream and resume flags (STANDIN_OLD: an older CLI without them)
const HELP = { claude: "--output-format <format> text, json or stream-json\\n--resume [value]", codex: "Commands:\\n  resume\\n--json  Print events to stdout as JSONL",
  "cursor-agent": "--output-format <format> text | json | stream-json\\n--resume [chatId]", agy: "--conversation  Resume\\n--output-format (text, json, stream-json)\\n--settings" };
if (a.includes("--help")) { if (!process.env.STANDIN_OLD) console.log(HELP[tool]); process.exit(0); }
if (tool === "claude") {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  if (a[0] === "auth") { const f = path.join(dir, "who.json"); if (fs.existsSync(f)) { process.stdout.write(fs.readFileSync(f)); process.exit(0); } j({ loggedIn: false }); process.exit(1); }
  if (a[0] === "plugin") process.exit(1);
} else if (tool === "codex") {
  if (a[0] === "debug") { j({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra", description: "Frontier.", context_window: 272000, visibility: "list" }, { slug: "x", visibility: "hide" }] }); process.exit(0); }
  if (a[0] === "plugin") process.exit(1);
} else if (tool === "cursor-agent") {
  if (a[0] === "status") { console.log("Logged in as cur@x.com\\nTeam: Acme Team (id 1)"); process.exit(0); }
  if (a[0] === "--list-models") { console.log("Available models\\n\\nauto - Auto (default)\\ngpt-5.3-codex-high - Codex 5.3 High\\nclaude-opus-5-thinking-high - Claude Opus 5 1M Thinking"); process.exit(0); }
} else if (tool === "agy") {
  if (a[0] === "models") { console.log("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)"); process.exit(0); }
  if (a[0] === "plugin") process.exit(1);
}
// a sub run: the brief is the last argument, or stdin (Windows shims: claude, and codex with "-")
const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : ""; };
const last = a[a.length - 1] || "";
const brief = tool === "claude" && !last.includes("sub-agent") || last === "-" ? fs.readFileSync(0, "utf8") : last;
const resumed = tool === "codex" ? (a[1] === "resume" ? a[a.length - 2] : "") : tool === "agy" ? val("--conversation") : val("--resume");
const stream = tool === "codex" ? a.includes("--json") : val("--output-format") === "stream-json";
const sid = resumed || tool + "-sess-" + process.pid;
let n = 0;
const E = {
  claude: { start: () => j({ type: "system", subtype: "init", session_id: sid, model: "m" }), tool: (x) => j({ type: "assistant", session_id: sid, parent_tool_use_id: null, message: { content: [{ type: "tool_use", name: "Bash", input: { command: x } }] } }),
    end: (t) => j({ type: "result", subtype: "success", is_error: false, result: t, session_id: sid }) },
  codex: { start: () => j({ type: "thread.started", thread_id: sid }), tool: (x) => j({ type: "item.started", item: { id: "i" + ++n, type: "command_execution", command: x, status: "in_progress" } }),
    end: (t) => { j({ type: "item.completed", item: { id: "m", type: "agent_message", text: t } }); j({ type: "turn.completed", usage: {} }); } },
  "cursor-agent": { start: () => j({ type: "system", subtype: "init", session_id: sid, model: "m" }), tool: (x) => j({ type: "tool_call", subtype: "started", call_id: "c" + ++n, tool_call: { shellToolCall: { args: { command: x } } }, session_id: sid }),
    end: (t) => { j({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] }, session_id: sid }); j({ type: "result", subtype: "success", is_error: false, result: t, session_id: sid }); } },
  agy: { start: () => j({ event: "init", conversation_id: sid, init: { cwd: process.cwd(), permission_mode: "always-proceed" } }),
    tool: (x) => j({ event: "step_update", step_update: { conversation_id: sid, step_index: ++n, state: "ACTIVE", step_type: "tool", tool_info: { name: "run_command", parameters: { CommandLine: x } } } }),
    end: (t) => { j({ event: "step_update", step_update: { conversation_id: sid, step_index: ++n, state: "DONE", step_type: "agent_response", text_delta: t } }); j({ event: "result", result: { conversation_id: sid, status: "SUCCESS", response: t } }); } },
};
const plain = { start() {}, tool: (x) => process.stderr.write("running " + x + "\\n"), end: (t) => console.log(t) };
const out = stream && !brief.includes("NOSTREAM") ? E[tool] : plain;
out.start();
if (brief.includes("SLEEP")) setTimeout(() => {}, 600000);
else if (brief.includes("REPEAT")) setInterval(() => process.stderr.write("root agent idle; waiting for 1 background task(s) to finish\\n"), 200);
else if (brief.includes("SPAWN")) { const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" }); fs.writeFileSync("grandchild.pid", String(c.pid)); out.tool("long command"); setTimeout(() => {}, 600000); }
else {
  if (brief.includes("SLOW")) for (const s of "ABCDEF") { out.tool("step " + s); await sleep(400); }
  if (brief.includes("EDIT")) fs.writeFileSync("made.txt", "hi");
  const r = resumed ? " resumed:" + resumed : "";
  out.end(tool === "agy" ? "gemini ran: " + brief.split("\\n")[1] + r : JSON.stringify({ tool, argv: a, resumed, dir: process.env.CLAUDE_CONFIG_DIR || "default", token: process.env.CLAUDE_CODE_OAUTH_TOKEN || "none", bg: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS || "" }));
}
`);
const launcher = (name, pre = "") => WIN ? mk(path.join(BINDIR, name + ".cmd"), `@echo off\r\n${pre ? `set ${pre}\r\n` : ""}node "${STANDIN}" ${name} %*\r\n`)
  : (mk(path.join(BINDIR, name), `#!/bin/sh\n${pre ? `export ${pre}\n` : ""}exec node "${STANDIN}" ${name} "$@"\n`), fs.chmodSync(path.join(BINDIR, name), 0o755));
for (const name of ["claude", "codex", "cursor-agent", "agy"]) launcher(name);


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
      chats.push({ model: b.model, tools: (b.tools || []).map((t) => t.function.name).sort(), think: b.think, num_ctx: b.options?.num_ctx, images: (user.images || []).length, text: user.content, users: b.messages.filter((m) => m.role === "user").map((m) => m.content) });
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

// 5b. jobs: progress, background runs, follow-ups, stalls, stop, interrupted runners, plain-mode fallback, pruning
const JW = path.join(H, "jobwork"); fs.mkdirSync(JW);
const JOBS = path.join(H, ".subhub", "jobs");
const jobOf = (r) => (r.err + r.out).match(/job ([0-9a-f]{6})/)?.[1];
const meta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(JOBS, id, "job.json"), "utf8")); } catch { return {}; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const pause = (ms) => new Promise((res) => setTimeout(res, ms));
r = await sh(["ask", "--in", JW, claude2, "opus", "first task"]);
let id = jobOf(r), m = meta(id); j = {}; try { j = JSON.parse(r.out.trim()); } catch {}
ok(r.code === 0 && j.tool === "claude" && r.err.trim().split("\n").length === 1 && !/Bash|started/.test(r.out), "foreground ask prints only the answer (one stderr line)", JSON.stringify(r));
ok(j.argv?.includes("stream-json") && j.bg === "1", "Claude runs in stream-json mode, background tasks off", JSON.stringify(j.argv));
ok(m.state === "done" && m.code === 0 && m.sub === claude2 && m.folder === fs.realpathSync(JW) && m.session?.startsWith("claude-sess-") && m.stream === true && m.pid > 0 && m.ended >= m.started, "job folder and metadata written", JSON.stringify(m));
ok(["brief.txt", "progress.log", "answer.txt", "stdout.log", "stderr.log"].every((f) => fs.existsSync(path.join(JOBS, id, f))) && /started on m/.test(fs.readFileSync(path.join(JOBS, id, "progress.log"), "utf8")), "job folder has brief, progress, raw output and answer");
if (!WIN) ok((fs.statSync(path.join(JOBS, id)).mode & 0o777) === 0o700, "job folder is private (0700)");
ok(/foreground and wait/.test(fs.readFileSync(path.join(JOBS, id, "brief.txt"), "utf8")), "brief tells the sub not to start background tasks");
r = await sh(["ask", "--continue", id, "follow up"]); let j2 = {}; try { j2 = JSON.parse(r.out.trim()); } catch {}
const c1 = jobOf(r);
ok(r.code === 0 && j2.resumed === m.session && j2.argv.includes("--resume") && j2.argv.includes("opus") && j2.dir.endsWith(".claude-acct2") && meta(c1).parent === id, "continue: Claude gets --resume <session>, same account and model", JSON.stringify(j2));
r = await sh(["ask", "--continue", c1, "--model", "haiku", "again"]); try { j2 = JSON.parse(r.out.trim()); } catch { j2 = {}; }
ok(r.code === 0 && j2.resumed === m.session && j2.argv.includes("haiku"), "a follow-up can be continued again, with another model", JSON.stringify(j2));
for (const [sub, flag] of [["codex-1", "resume"], ["cursor-1", "--resume"]]) {
  const a = await sh(["ask", "--in", JW, sub, "default", "x"]), aid = jobOf(a), s0 = meta(aid).session;
  const b = await sh(["ask", "--continue", aid, "more"]); let o = {}; try { o = JSON.parse(b.out.trim()); } catch {}
  ok(a.code === 0 && s0 && b.code === 0 && o.resumed === s0 && o.argv.includes(flag) && (sub !== "codex-1" || (o.argv[0] === "exec" && o.argv[1] === "resume")), `continue: ${sub} resumes its session (${flag})`, JSON.stringify([a.err, s0, b.out, b.err]));
}
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nhello"]); id = jobOf(r);
ok(r.out.trim().startsWith("gemini ran") && meta(id).session?.startsWith("agy-sess-"), "Antigravity stream-json answer and conversation id", r.out + r.err);
r = await sh(["ask", "--continue", id, "and then"]); ok(r.code === 0 && r.out.includes(`resumed:${meta(id).session}`), "continue: Antigravity gets --conversation <id>", r.out + r.err);
r = await sh(["ask", "--in", JW, "ollama-1", "agent:8b", "x\nFIRSTQ"]); id = jobOf(r);
chats.length = 0; r = await sh(["ask", "--continue", id, "SECONDQ"]);
ok(r.code === 0 && fs.existsSync(path.join(JOBS, id, "history.json")) && chats[0]?.users.length === 2 && chats[0].users[0].includes("FIRSTQ") && chats[0].users[1].includes("SECONDQ"), "continue: Ollama reloads the saved conversation", JSON.stringify(chats[0]?.users));
// background run, progress while it runs, wait
let t1 = Date.now(); r = await sh(["ask", "--bg", "--in", JW, "gemini-1", "default", "x\nSLOW"]); id = jobOf(r);
ok(r.code === 0 && id && Date.now() - t1 < 4000 && /job wait/.test(r.out), "--bg returns at once with the job id", r.out + r.err);
let seen = false;
for (let i = 0; i < 40 && !seen; i++) { await pause(150); const t = await sh(["job", "tail", id]); seen = /run_command step [A-E]/.test(t.out) && meta(id).state === "running"; }
ok(seen, "progress lines appear while the sub runs", fs.existsSync(path.join(JOBS, id, "progress.log")) ? fs.readFileSync(path.join(JOBS, id, "progress.log"), "utf8") : "no progress.log");
r = await sh(["job", id]); ok(/running|done/.test(r.out) && /last activity \d+s ago/.test(r.out) && /Last progress/.test(r.out), "job shows state and time since last activity", r.out);
r = await sh(["job", "wait", id, "30"]); ok(r.code === 0 && r.out.includes("gemini ran"), "job wait returns the answer", r.out + r.err);
r = await sh(["job", "result", id]); ok(r.code === 0 && r.out.includes("gemini ran"), "job result prints the answer");
r = await sh(["jobs", "--json"]); let list = []; try { list = JSON.parse(r.out); } catch {}
ok(list.some((x) => x.id === id && x.state === "done" && x.continuable === true), "jobs --json lists recent jobs");
r = await sh(["ask", "--bg", "--in", JW, "gemini-1", "default", "x\nSLEEP"]); id = jobOf(r);
r = await sh(["job", "wait", id, "1"]); ok(r.code === 14 && /running/.test(r.out), "job wait gives up after its seconds (exit 14)", `${r.code} ${r.out}`);
await sh(["job", "stop", id]);
// stalls: silent, and a repeating "waiting for background task" line
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nSLEEP"], { env: { SUBHUB_IDLE: "2" } }); id = jobOf(r);
ok(r.code === 12 && meta(id).state === "stalled" && /stalled/.test(r.err) && /--continue/.test(r.err), "a silent sub is stopped as stalled (exit 12), continuable", `${r.code} ${r.err}`);
r = await sh(["ask", "--continue", id, "go on"]); ok(r.code === 0 && r.out.includes("resumed:"), "a stalled job can be continued", r.out + r.err);
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nREPEAT"], { env: { SUBHUB_IDLE: "2" } }); id = jobOf(r);
ok(r.code === 12 && /repeated/.test(fs.readFileSync(path.join(JOBS, id, "progress.log"), "utf8")), "a sub that only repeats one line counts as stalled", `${r.code} ${r.err}`);
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nSLEEP"], { env: { SUBHUB_TIMEOUT: "2" } }); id = jobOf(r);
ok(r.code === 124 && meta(id).state === "timeout" && /--continue/.test(r.err), "a timed-out job says it can be continued", r.err);
// stop kills the whole tree
fs.rmSync(path.join(JW, "grandchild.pid"), { force: true });
r = await sh(["ask", "--bg", "--in", JW, "gemini-1", "default", "x\nSPAWN"]); id = jobOf(r);
for (let i = 0; i < 50 && !fs.existsSync(path.join(JW, "grandchild.pid")); i++) await pause(100);
const gpid = +fs.readFileSync(path.join(JW, "grandchild.pid"), "utf8") || 0;
r = await sh(["job", "stop", id]); await pause(500);
ok(gpid && !alive(gpid) && meta(id).state === "stopped" && meta(id).code === 13 && /Continue it/.test(r.out), "job stop stops the whole process tree, stays continuable", `${gpid} ${alive(gpid)} ${JSON.stringify(meta(id))} ${r.out}`);
// a runner that died without recording an end
const dead = spawnSync(process.execPath, ["-e", ""]).pid;
mk(path.join(JOBS, "dead01", "job.json"), JSON.stringify({ id: "dead01", sub: "gemini-1", provider: "gemini", model: "default", folder: JW, started: Date.now() - 5000, state: "running", pid: dead, timeout: 1800, idle: 900, session: "s" }));
r = await sh(["job", "dead01"]); ok(/interrupted/.test(r.out) && meta("dead01").state === "interrupted", "a dead runner shows as interrupted", r.out);
// plain-mode fallback: a CLI without a stream mode, and a stream that can't be parsed
launcher("agy", "STANDIN_OLD=1");
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nold cli"]); id = jobOf(r);
ok(r.code === 0 && r.out.includes("gemini ran") && meta(id).stream === false, "no stream mode: falls back to plain output", r.out + r.err);
r = await sh(["ask", "--continue", id, "more"]); ok(r.code === 11 && /can't be continued/.test(r.err), "continue with no session id fails clearly (exit 11)", `${r.code} ${r.err}`);
launcher("agy");
r = await sh(["ask", "--in", JW, "gemini-1", "default", "x\nNOSTREAM"]); ok(r.code === 0 && r.out.includes("gemini ran"), "unparsable stream: the output is read as plain text", r.out + r.err);
r = await sh(["ask", "--continue", "nope99", "x"]); ok(r.code === 2, "continue of an unknown job (exit 2)");
// old jobs go
mk(path.join(JOBS, "old001", "job.json"), JSON.stringify({ id: "old001", sub: "gemini-1", state: "done", started: Date.now() - 9 * 86400000, ended: Date.now() - 8 * 86400000 }));
await sh(["jobs"]); ok(!fs.existsSync(path.join(JOBS, "old001")) && fs.existsSync(path.join(JOBS, "dead01")), "jobs older than 7 days are pruned");

// 6. agents: connect and disconnect (with the always-on rule in each agent's global rules file)
const CMD = path.join(H, ".claude", "CLAUDE.md"), AMD = path.join(H, ".codex", "AGENTS.md"), GMD = path.join(H, ".gemini", "config", "AGENTS.md");
const CMD0 = "# My rules\n\nUse tabs.", AMD0 = "# Codex rules\r\n\r\nBe brief.\r\n";
mk(CMD, CMD0);
let amdReal = AMD;
if (!WIN) { amdReal = path.join(H, "dotfiles", "AGENTS.md"); mk(amdReal, AMD0); fs.chmodSync(amdReal, 0o640); fs.symlinkSync(amdReal, AMD); } else mk(AMD, AMD0);
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const blocks = (t) => (t || "").split("<!-- subhub:start").length - 1;
r = await sh(["connect", "all", "--no-rules"]);
ok(read(CMD) === CMD0 && read(AMD) === AMD0 && !fs.existsSync(GMD) && !fs.existsSync(CMD + ".subhub-backup"), "connect --no-rules writes no rule", r.out + r.err);
r = await sh(["connect", "claude"], { env: { SUBHUB_NO_RULES: "1" } }); ok(read(CMD) === CMD0, "SUBHUB_NO_RULES=1 writes no rule");
r = await sh(["connect", "all"]);
ok(r.out.includes(`always-on rule in ${CMD}`) && r.out.includes(`always-on rule in ${GMD}`) && /Cursor: connected; no global rules file/.test(r.out), "connect says which file has the rule", r.out);
for (const [f, orig, name] of [[CMD, CMD0, "Claude Code"], [AMD, AMD0, "Codex"]]) {
  const t = read(f) || "";
  ok(t.startsWith(orig) && blocks(t) === 1 && t.includes("run `subhub list`") && t.trimEnd().endsWith("<!-- subhub:end -->"), `${name}: rule added after the existing content`, JSON.stringify(t.slice(0, 120)));
  ok(read(f + ".subhub-backup") === orig, `${name}: original backed up`);
}
ok(/\r\n<!-- subhub:start[^\n]*\r\n## /.test(read(AMD)), "Codex: CRLF file gets CRLF lines");
if (!WIN) ok(fs.lstatSync(AMD).isSymbolicLink() && (fs.statSync(amdReal).mode & 0o777) === 0o640, "symlinked rules file stays a symlink, mode kept");
ok(blocks(read(GMD)) === 1 && read(GMD).startsWith("<!-- subhub:start") && !fs.existsSync(GMD + ".subhub-backup"), "Antigravity: missing rules file created, no backup");
ok(!fs.existsSync(path.join(H, ".cursor", "AGENTS.md")) && !fs.readdirSync(path.join(H, ".cursor")).some((f) => /\.md$/i.test(f)), "Cursor: no rules file written");
await sh(["connect", "claude"]); ok(blocks(read(CMD)) === 1 && read(CMD).startsWith(CMD0), "second connect leaves one block");
fs.writeFileSync(CMD, read(CMD).replace(/<!-- subhub:start[\s\S]*?<!-- subhub:end -->/, "<!-- subhub:start v1.0.0 -->\nold text\n<!-- subhub:end -->") + "after\n");
await sh(["connect", "claude"]); let t = read(CMD);
ok(blocks(t) === 1 && !t.includes("old text") && t.includes("SUBHUB_DEPTH") && t.startsWith(CMD0) && t.endsWith("<!-- subhub:end -->\nafter\n"), "older block replaced in place", JSON.stringify(t));
fs.writeFileSync(CMD, t.replace(/after\n$/, ""));
r = await sh(["status", "--json"]); st = JSON.parse(r.out);
const ag = Object.fromEntries(st.agents.map((a) => [a.id, a]));
ok(ag.claude.rules === true && ag.claude.rulesFile === CMD && ag.codex.rules && ag.gemini.rules && ag.cursor.rules === false && ag.cursor.rulesFile === null && "connected" in ag.claude, "status --json reports the rule per agent", JSON.stringify(st.agents));
r = await sh(["status"]); ok(r.out.includes(`always-on rule in ${CMD}`), "status shows the rule file");

const cur = JSON.parse(fs.readFileSync(path.join(H, ".cursor", "cli-config.json"), "utf8"));
ok(fs.existsSync(path.join(H, ".claude", "skills", "subhub", "skills", "subhub", "SKILL.md")) && JSON.parse(fs.readFileSync(path.join(H, ".claude", "settings.json"), "utf8")).permissions.allow.includes("Bash(subhub *)"), "Claude Code connected (plugin + rule)");
ok(fs.existsSync(path.join(H, ".codex", "skills", "subhub", "SKILL.md")) && fs.readFileSync(path.join(H, ".codex", "rules", "subhub.rules"), "utf8").includes('prefix_rule(pattern = ["subhub"]'), "Codex connected (skill + rule)");
ok(fs.existsSync(path.join(H, ".gemini", "config", "skills", "subhub", "SKILL.md")) && JSON.parse(fs.readFileSync(path.join(H, ".gemini", "antigravity-cli", "settings.json"), "utf8")).permissions.allow.includes("command(subhub)"), "Antigravity connected (skill + rule)");
ok(cur.permissions.allow.includes("Shell(ls)") && cur.permissions.allow.includes("Shell(subhub)") && fs.existsSync(path.join(H, ".cursor", "skills", "subhub", "SKILL.md")), "Cursor connected, its own rules kept");
await sh(["disconnect", "all"]);
const cur2 = JSON.parse(fs.readFileSync(path.join(H, ".cursor", "cli-config.json"), "utf8"));
ok(cur2.permissions.allow.join() === "Shell(ls)" && !fs.existsSync(path.join(H, ".cursor", "skills", "subhub")) && !fs.existsSync(path.join(H, ".codex", "rules", "subhub.rules")), "disconnect removes exactly what was added");
ok(read(CMD) === CMD0 && read(AMD) === AMD0, "disconnect restores the rules files byte for byte", JSON.stringify([read(CMD), read(AMD)]));
ok(!fs.existsSync(GMD), "disconnect removes the rules file SubHub created");
if (!WIN) ok(fs.lstatSync(AMD).isSymbolicLink(), "symlink still a symlink after disconnect");
r = await sh(["status", "--json"]); ok(JSON.parse(r.out).agents.every((a) => a.rules === false), "status: no rule after disconnect");

// 7. install and remove
r = await sh(["install"], { env: { SUBHUB_REPO: ROOT } });
ok(fs.existsSync(path.join(H, ".subhub", "bin", "subhub.mjs")) && fs.existsSync(path.join(H, ".subhub", "bin", WIN ? "subhub.cmd" : "subhub")), "install puts the engine and launcher in ~/.subhub/bin", r.out + r.err);
ok(r.out.includes(`always-on rule in ${CMD}`) && blocks(read(CMD)) === 1, "install writes the rule and says where", r.out);
await sh(["disconnect", "all"]); r = await sh(["install"], { env: { SUBHUB_REPO: ROOT, SUBHUB_NO_RULES: "1" } });
ok(read(CMD) === CMD0 && !fs.existsSync(GMD) && r.out.includes("always-on rule skipped"), "SUBHUB_NO_RULES=1 install writes no rule", r.out);
if (!WIN) { const l = spawnSync(path.join(H, ".local", "bin", "subhub"), ["version"], { env: baseEnv, encoding: "utf8" }); ok(/subhub \d/.test(l.stdout), "~/.local/bin/subhub runs", l.stderr); }
else { const l = spawnSync("cmd.exe", ["/d", "/c", path.join(H, ".subhub", "bin", "subhub.cmd"), "version"], { env: baseEnv, encoding: "utf8" }); ok(/subhub \d/.test(l.stdout), "subhub.cmd runs", l.stderr); }
const team = Object.values(subs).find((s) => /Acme/.test(s.label)).name;
await sh(["remove", team]); r = await sh(["status", "--json", "--refresh"]); ok(!JSON.parse(r.out).subs.some((s) => s.name === team), "removed sub isn't added back");

server.close();
console.log((failures ? `\n${failures} FAILED` : "\nAll passed") + ` (${process.platform}, node ${process.version}, ${((Date.now() - T0) / 1000).toFixed(1)}s)`);
if (!process.env.SUBHUB_KEEP) fs.rmSync(H, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
