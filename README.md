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

SubHub is a plugin with two skills, for Claude Code, Codex and Antigravity, and for Cursor through its skills folder. It runs on **macOS, Linux and Windows**. One Node.js file, `subhub.mjs`, does the work, using only Node's built-in modules. There's no server and no daemon: state is plain files in `~/.subhub`, and a background job is one process that ends with the job.

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

`subhub install` does five things:
- puts `subhub` in `~/.local/bin`
- finds every AI account you're signed in to
- installs the plugin into each agent that's installed
- adds one permission rule per agent, so the agent can run `subhub` without asking
- adds a short always-on rule to each agent's global rules file (see below), and prints which file it wrote

### Always-on rule

A skill only loads when the agent decides a task matches it, so agents often fall back to their built-in sub-agents and spend the calling account's usage. To make subs the default, `subhub connect` (and so `subhub install`) adds a block of about six lines to the agent's global, all-projects rules file. The block tells the agent to run `subhub list` and hand delegable work to a ready sub before starting a built-in sub-agent, except for tiny tasks, work that needs the conversation's context, briefs that would contain secrets, or when it is itself a sub.

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
- **SubHub never starts, downloads or signs in to anything by itself.** It never starts Ollama and never downloads a model.
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

`~/.subhub/config.json` holds, per sub: on/off, what it's for, its default model, and notes added to every brief. A top-level `order` sets the order agents try subs in. Ask your agent to "change my SubHub settings" (the `subhub-config` skill), or run:

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
  bin/subhub.mjs                  the engine (Node.js 18+, built-in modules only)
  bin/subhub, bin/subhub.cmd      launchers for macOS/Linux and Windows
test/smoke.mjs                    test against stand-in CLIs and a stand-in Ollama (CI: macOS, Linux, Windows)
install.sh, install.ps1           one-line installers (macOS/Linux, Windows)
```

## Requirements

macOS, Linux or Windows with Node.js 18+, plus at least two AI CLIs signed in. Each sub's usage counts against that subscription. Check each provider's terms on scripted use and on using several accounts.

MIT licence.
