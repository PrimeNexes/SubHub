# SubHub (alpha)

Use your other AI subscriptions as sub-agents, from any AI agent on your computer.

> **Alpha.** SubHub is early and changes often. Commands, settings and file locations may change between versions without a migration.
> - It's developed and used on macOS. Linux and Windows are covered only by an automated test against stand-in CLIs.
> - The installer changes each agent's settings and global rules file (it backs each one up first, and `subhub disconnect all` undoes it).
> - Subs run with full access and no approval prompts.
>
> Try it on a machine and accounts you can afford to have go wrong, and please [report problems](https://github.com/PrimeNexes/SubHub/issues).

You pay for several AI subscriptions: a second Claude account, a team and a personal organization on one email, Codex, Cursor, Antigravity (Gemini), a local Ollama. SubHub lets whichever agent you're working in hand a task to any of the others. Uses include:
- a second opinion from another model family
- a 900-page PDF for a 1M-token model
- parallel side work
- carrying on after a usage limit

SubHub is a plugin with two skills (plus a relay agent and a redirect hook in Claude Code), for Claude Code, Codex and Antigravity, and for Cursor through its skills folder. It runs on **macOS, Linux and Windows**. One Node.js file, `subhub.mjs`, does the work, using only Node's built-in modules. There's no server and no daemon: state is plain files in `~/.subhub`, and a background job is one process that ends with the job.

## Install

**macOS and Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.ps1 | iex
```

Both need [Node.js](https://nodejs.org) 18 or newer. On Windows, `winget install OpenJS.NodeJS.LTS` installs it.

`subhub install` does six things:
- puts `subhub` in `~/.local/bin`
- finds every AI account you're signed in to
- installs the plugin into each agent that's installed
- adds one permission rule per agent, so the agent can run `subhub` without asking
- adds a short always-on rule to each agent's global rules file (see below), and prints which file it wrote
- checks which subs actually work (see [Which subs actually work](#which-subs-actually-work)): this sends one tiny test prompt to each sub that has no free check, so it uses a little of their usage. `subhub install --no-check` (or `SUBHUB_NO_CHECK=1`) skips it

### Always-on rule

A skill only loads when the agent decides a task matches it, so agents often fall back to their built-in sub-agents and spend the calling account's usage. To make subs the default, `subhub connect` (and so `subhub install`) adds a block of about seven lines to the agent's global, all-projects rules file. The block tells the agent to hand delegable work to a ready sub before starting a built-in sub-agent (running `subhub list` once per task), except for tiny tasks, work that needs the conversation's context, briefs that would contain secrets, or when it is itself a sub. If a sub fails, the agent tries one other sub once and then does the work itself; it never retries the same sub in a loop. In Claude Code with the plugin installed, the block has one more line pointing at the relay agent (below).

| Agent | File |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `AGENTS.md` in `CODEX_HOME` (default `~/.codex`); `AGENTS.override.md` there instead if you have a non-empty one, since Codex then reads only that |
| Antigravity | `~/.gemini/config/AGENTS.md` (not `~/.gemini/GEMINI.md`, which Gemini CLI also reads) |
| Cursor | none: Cursor's User Rules live in its settings, not in a file the CLI reads, so Cursor gets the skill only |

The block sits between `<!-- subhub:start … -->` and `<!-- subhub:end -->`. SubHub never touches anything outside those lines; connecting again refreshes the block in place. The first time it changes an existing file, SubHub saves a copy as `<file>.subhub-backup`.

- **Skip it:** `subhub connect <agent> --no-rules`, `subhub install --no-rules`, or `SUBHUB_NO_RULES=1` for the one-line installers (`curl -fsSL …/install.sh | SUBHUB_NO_RULES=1 sh`, or `$env:SUBHUB_NO_RULES=1` before `irm … | iex`).
- **Remove it:** `subhub disconnect <agent>` takes the block out and leaves the rest of the file as it was (a file SubHub created is deleted). Or delete the marked lines yourself.
- `subhub status` shows which agents have the rule.

### Claude Code: relay agent and redirect hook

Claude Code's built-in Agent tool is one native tool call, while a rule and a skill are several steps, so Claude Code tends to start its own sub-agents anyway. The plugin adds two things for Claude Code only:

- **The `subhub:relay` agent** (`plugins/subhub/agents/relay.md`). Claude starts it with its Agent tool, in one call, like any sub-agent. It runs on Haiku with only the Bash tool, and only relays: it passes the prompt verbatim to a sub with `subhub ask --bg`, waits with `subhub job wait`, and returns the sub's answer, the changed-files note and the job id. To pick the sub, the prompt's first line is `use: <sub> [model]`; for a follow-up to an earlier relay job, `continue: <job id> [model]`. Without one, it picks the first ready sub that fits from `subhub list`. If the sub fails, stalls or is at its usage limit, it tries one other sub once, then returns a line starting `SUBHUB_RELAY_FAILED:` that tells Claude to do the work itself.
- **A redirect hook** (`plugins/subhub/hooks/hooks.json`, `PreToolUse` on `Agent|Task`, which runs `node <plugin>/bin/subhub.mjs hook pretool`). When Claude is about to start a generic built-in sub-agent (`general-purpose`, `Explore`, the `claude` catch-all, or a call with no type) and a sub is ready, the hook blocks that call once and tells Claude to use `subhub:relay`. Repeating the same call (same session, same prompt) goes ahead, so it can never loop. It never touches custom or plugin agents, `Plan`, forks or the relay itself, does nothing inside a sub, when no sub is ready (on, signed in, working or not yet checked, and not the account Claude runs as), when the `subhub` on PATH is missing or a different version from the plugin (the relay would call commands it doesn't have), or on any error. It reads only `~/.subhub/registry.json`, `config.json` and the version line of `~/.subhub/bin/subhub.mjs`: no network, no CLI runs; it costs about 10 ms on top of Node's start-up.
- **Turn the hook off:** `"hook": false` in `~/.subhub/config.json`, or `SUBHUB_HOOK=0` in Claude Code's environment. `"hook_types": [...]` changes which agent types it redirects. `subhub status` shows whether it's on.

Both load only when SubHub is installed through Claude Code's plugin manager (`subhub connect claude` tries that first). If that fails, `subhub connect claude` copies the plugin folder into `~/.claude/skills/subhub` instead; there Claude Code loads the skills only, **not the relay agent and not the hook**, and the always-on rule leaves out the relay line. Codex, Antigravity and Cursor keep the rule and the skill only.

Or install the plugin through each agent's own plugin manager:

| Agent | Install |
|---|---|
| Claude Code | `/plugin marketplace add PrimeNexes/SubHub` then `/plugin install subhub@subhub` |
| Codex | `codex plugin marketplace add https://github.com/PrimeNexes/SubHub` then `codex plugin add subhub@subhub` |
| Antigravity | clone the repo, then `agy plugin install SubHub/plugins/subhub` |
| Cursor | copy `plugins/subhub/skills/subhub` to `~/.cursor/skills/` |
| Any agent | `npx skills add PrimeNexes/SubHub` (the [Agent Skills](https://agentskills.io) standard) |

Then run `node <plugin folder>/bin/subhub.mjs install` once. It adds the permission rules and finds your accounts.

## Use it

Ask any connected agent in plain words:

> Have my other Claude account review this diff.
> Use gemini-1 to summarise docs/spec.pdf.
> Ask Codex for a second opinion on the race in worker.go, report only.

The agent runs `subhub list`, picks a sub and a model, and calls:

```sh
subhub ask <sub> <model|default> <<'SUBHUB_BRIEF_END'
<self-contained brief>
SUBHUB_BRIEF_END
```

## Jobs, progress and follow-ups

Every `subhub ask` is a job with a short id, kept in `~/.subhub/jobs/<id>/` for 7 days: its metadata (sub, model, folder, times, state, exit code, the sub CLI's session id), the brief, a progress log, raw output and the final answer. A foreground ask still prints only the answer; one stderr line names the job.

| Command | Does |
|---|---|
| `subhub ask --bg gemini-1 default <<'SUBHUB_BRIEF_END'` … | starts the job in the background and prints its id at once |
| `subhub job wait 3f9a2c 600` | waits up to 600 seconds, then prints the answer (or the status, exit 14, if it's still running) |
| `subhub job 3f9a2c` | state, elapsed time, time since the last activity, the last progress lines, whether it can be continued |
| `subhub job tail 3f9a2c 40` | the last 40 progress lines |
| `subhub job result 3f9a2c` | the answer and the files that changed |
| `subhub job stop 3f9a2c` | stops it and everything it started |
| `subhub jobs` | running and recent jobs (`--json` for scripts) |
| `subhub ask --continue 3f9a2c "Now add tests"` | a follow-up in the same conversation: same sub, account and folder (`--model` to switch model, `--bg` works too) |

**Progress.** SubHub runs each CLI in its documented streaming mode and turns the events into short timestamped lines (commands, file edits, what the agent says, errors):

| Sub | Stream | Continue |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --verbose` | `--resume <session_id>` |
| Codex | `codex exec --json` | `codex exec resume <thread_id>` |
| Cursor | `cursor-agent -p --output-format stream-json` | `--resume <session_id>` |
| Antigravity | `agy -p --output-format stream-json` | `--conversation <conversation_id>` |
| Ollama | SubHub's own agent loop logs each step and tool call | the conversation saved in the job folder |

SubHub checks each CLI's `--help` for these flags; a CLI without them, or a stream it can't read, runs in plain mode as before (stdout is the answer, stderr lines are the progress). A job can be continued after it finishes, times out, stalls or is stopped, as long as a session id was captured; otherwise `--continue` fails with exit 11 instead of starting fresh. A job whose runner died (reboot, kill) shows as interrupted.

**Stalls.** Every brief tells the sub to run commands in the foreground and never leave background tasks running, because nobody collects them in a headless run (Claude subs also run with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). If a sub shows no activity for 15 minutes (`SUBHUB_IDLE` seconds, `0` turns it off), SubHub stops it as stalled (exit 12); a line that only repeats, like `waiting for 1 background task(s) to finish`, doesn't count as activity. 15 minutes is longer than one long command: Claude Code's Bash tool stops a command at 10 minutes. `SUBHUB_PLAIN=1` turns streaming off.

## Which subs actually work

Signed in isn't the same as working: a plan can be out of credits, an account at its usage limit until some time, a subscription lapsed, or a CLI signed in but refused in headless runs (Cursor's `status` can say "Logged in" while a run says "Authentication required"). SubHub keeps a health record with each sub: **working**, **at its usage limit** (with the reset time when the CLI names one), **out of credits or no plan**, **not authorised for headless runs**, **failing** (with the CLI's last error line), or **unknown** (not checked yet).

- **Learned for free from every real `subhub ask`.** A normal answer marks the sub working; a limit, credits or sign-in error marks it so, with the reset time. This is the main source in daily use.
- **`subhub list`** puts only working and unknown subs in the ready table; the rest go under "Not ready" with the reason, for example `claude-2 (at its usage limit until 21:40: You've hit your limit · resets 9:40pm)`. Once a reset time passes the sub counts as unknown again and is simply tried; an unrecognised failure is retried after 30 minutes, and a limit with no reset time after an hour.
- **`subhub ask`** to a sub known to be at its limit (reset still ahead) or out of credits fails at once with **exit 9** and the reason, without starting the CLI. `subhub ask --force …` tries anyway.
- **`subhub status`** (and `--json`) shows each sub's health and when it was last seen. The redirect hook and the relay agent skip subs that aren't working.
- **`subhub check [sub…] [--json]`** re-tests every sub (or the named ones) in parallel and prints sub, account, result, reset time and reason. It runs free checks first and a test prompt only where those can't prove the sub works. It never tests the account you're running as ("this is you, not checked"), never starts Ollama, and never downloads a model.

| Sub | Free checks (no prompt, no usage) | Test prompt still needed? |
|---|---|---|
| Claude Code | `claude auth status` (signed in, plan) | yes: Claude Code has no non-interactive usage command (`/usage` is interactive). `claude -p … --model haiku` |
| Codex | `codex login status`; `codex app-server` → `account/read` and `account/rateLimits/read` (each window's % used and reset time) | only if the app server gives no rate limits |
| Cursor | `cursor-agent status`, `--list-models` | yes: no usage command, and `status` can say logged in while headless runs are refused. Model `auto` |
| Antigravity | `agy models` | yes: quota is only in the interactive `/usage`. The cheapest Flash model from `agy models` |
| Ollama | `/api/tags`, `/api/show` (running, models); `https://ollama.com/api/balance` for cloud credits when `OLLAMA_API_KEY` is set | no for local models (they're free); only for cloud-only setups without `OLLAMA_API_KEY` |

**What a check costs.** SubHub never spends your usage on its own. A test prompt is one tiny headless prompt per sub ("Reply with exactly one word: PONG") on that sub's cheapest model, in an empty temporary folder, with a 75-second limit, through the same path as a normal ask (same account, pins and flags). Only `subhub check`, `subhub list --refresh` and `subhub install` (`--no-check` skips it) send one. Plain `list`, `status`, the hook and `ask` never do.

The messages SubHub recognises (usage limits, rate limits, credits, payment, sign-in, for each CLI) are one table in `subhub.mjs` (`HEALTH_PATTERNS`), easy to extend; anything unrecognised counts as failing.

## Engine and plugin versions

Agents load the plugin (skills, relay agent, hook) from their own plugin copy, while `subhub` on PATH is the engine `subhub install` copied to `~/.subhub/bin`. If they differ, for example after a plugin update without `subhub install`, `subhub status` warns and names the fix (`subhub install` from the newer copy), and the redirect hook stays off until they match, so Claude Code is never sent to a relay that can't work.

## Accounts

`subhub status` shows every sub, every agent, and accounts found on this computer that aren't signed in yet.

| Provider | How SubHub finds accounts |
|---|---|
| Claude Code | The default sign-in; every `~/.claude-*` folder; `~/.subhub/accounts/claude-*`; any `CLAUDE_CONFIG_DIR` in your shell profile. One email with personal and team organizations becomes two subs. |
| Codex | `~/.codex` and any `CODEX_HOME` in your shell profile |
| Cursor | Its signed-in account |
| Antigravity | Its signed-in Google account |
| Ollama | Local models, while Ollama is running |

To add another Claude account or organization: `subhub signin claude --new --email you@company.com`, then pick the organization in the browser.

## What keeps it safe

- **Each sub stays the account it was first signed in as.** If its sign-in changes, for example after a `/login` somewhere else, it stops (exit 10) until you sign it in again.
- **An agent never gets its own account as a sub** (exit 6).
- **Subs use their own sign-in, never the caller's.** SubHub drops the caller's session and token variables before starting a sub.
- **Subs run with full access, in the folder you call from.** The calling agent says in the brief what each sub may change. After each run in a git repo, SubHub lists the files that changed.
- **SubHub never starts, downloads or signs in to anything by itself.** It never starts Ollama and never downloads a model. It spends a sub's usage only when an agent asks it to, or for the tiny test prompt of `subhub check`, `subhub list --refresh` and `subhub install`.
- **There's a loop guard,** so a sub can't delegate further. Every run has a 30-minute timeout (`SUBHUB_TIMEOUT` seconds) and is stopped earlier if it shows no activity for 15 minutes (`SUBHUB_IDLE`); either way SubHub stops the sub's whole process tree, and the job can be continued with `subhub ask --continue <id>`.

## Ollama

SubHub talks to Ollama's API (`OLLAMA_HOST`, local or remote). It doesn't use `ollama run`. It reads each model's capabilities from `/api/show` and uses everything the model supports:

| Model reports | SubHub does |
|---|---|
| `tools` | Runs the model as a full agent: read/write files, list folders, run commands, plus Ollama `web_search`/`web_fetch` when `OLLAMA_API_KEY` is set |
| `vision` | Attaches image files named in the brief |
| `audio` | Transcribes `.wav` files named in the brief (`/v1/audio/transcriptions`) |
| `thinking` | Turns thinking on (`SUBHUB_OLLAMA_THINK=low\|medium\|high\|false` to change it); only the answer is returned |
| context length | Raises `num_ctx` to the model's maximum, capped by `SUBHUB_OLLAMA_CTX` (default 65536); Ollama's default is much smaller |
| cloud (`:cloud`) | Lists and uses it through your signed-in Ollama server |

**Ollama using your other subs:** `subhub ollama [--model M] [task]` runs a local model as an agent with two extra tools, `subhub_list` and `subhub_ask`, so it can hand work to Claude, Codex, Gemini and the rest. Without a task it opens a chat. You can also run Claude Code or Codex on an Ollama model (`ollama launch claude`, `ollama launch codex`). They already have the SubHub plugin.

SubHub never starts Ollama or downloads models.

## Settings

`~/.subhub/config.json` holds, per sub: on/off, what it's for, its default model, and notes added to every brief. A top-level `order` sets the order agents try subs in. A top-level `notes` is added to every brief for every sub (for example an answer style, so subs reply as tersely as your main agent). Ask your agent to "change my SubHub settings" (the `subhub-config` skill), or run:

```sh
subhub on|off <sub>
subhub remove <sub>
subhub connect|disconnect <claude|codex|gemini|cursor|all> [--no-rules]
```

## Repo layout

```
.claude-plugin/marketplace.json   Claude Code (and Codex) marketplace
.agents/plugins/marketplace.json  Codex marketplace
plugins/subhub/
  .claude-plugin/plugin.json      Claude Code plugin
  .codex-plugin/plugin.json       Codex plugin
  plugin.json                     Antigravity plugin
  skills/subhub/SKILL.md          delegate to a sub (Agent Skills format)
  skills/subhub-config/SKILL.md   settings and setup
  agents/relay.md                 Claude Code: the subhub:relay agent
  hooks/hooks.json                Claude Code: the redirect hook (subhub hook pretool)
  bin/subhub.mjs                  the engine (Node.js 18+, built-in modules only)
  bin/subhub, bin/subhub.cmd      launchers for macOS/Linux and Windows
test/smoke.mjs                    test against stand-in CLIs and a stand-in Ollama (CI: macOS, Linux, Windows)
install.sh, install.ps1           one-line installers (macOS/Linux, Windows)
```

## Requirements

macOS, Linux or Windows with Node.js 18+, plus at least two AI CLIs signed in. Each sub's usage counts against that subscription. Check each provider's terms on scripted use and on using several accounts.

MIT licence.
