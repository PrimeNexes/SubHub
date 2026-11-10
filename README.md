# SubHub

Use your other AI subscriptions as sub-agents, from any AI agent on your computer.

You pay for several AI subscriptions: a second Claude account, a team and a personal organization on one email, Codex, Cursor, Antigravity (Gemini), a local Ollama. SubHub lets whichever agent you're working in hand a task to any of the others. Uses include:
- a second opinion from another model family
- a 900-page PDF for a 1M-token model
- parallel side work
- carrying on after a usage limit

SubHub is a plugin with two skills, for Claude Code, Codex and Antigravity, and for Cursor through its skills folder. One shell script, `subhub`, does the work. There's no server and no background process.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.sh | sh
```

`subhub install` does four things:
- puts `subhub` in `~/.local/bin`
- finds every AI account you're signed in to
- installs the plugin into each agent that's installed
- adds one permission rule per agent, so the agent can run `subhub` without asking

Or install the plugin through each agent's own plugin manager:

| Agent | Install |
|---|---|
| Claude Code | `/plugin marketplace add PrimeNexes/SubHub` then `/plugin install subhub@subhub` |
| Codex | `codex plugin marketplace add https://github.com/PrimeNexes/SubHub` then `codex plugin add subhub@subhub` |
| Antigravity | clone the repo, then `agy plugin install SubHub/plugins/subhub` |
| Cursor | copy `plugins/subhub/skills/subhub` to `~/.cursor/skills/` |
| Any agent | `npx skills add PrimeNexes/SubHub` (the [Agent Skills](https://agentskills.io) standard) |

Then run `subhub install` once, from the plugin's `bin/` folder or the repo. It adds the permission rules and finds your accounts.

**macOS app (optional):** `SubHub.app` is setup and status only. Its Install button runs the same installer, and the window shows your subs and agents. Sign-ins open in Terminal.

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
- **There's a loop guard,** so a sub can't delegate further, and every run has a 30-minute timeout.

## Settings

`~/.subhub/config.json` holds, per sub: on/off, what it's for, its default model, and notes added to every brief. A top-level `order` sets the order agents try subs in. Ask your agent to "change my SubHub settings" (the `subhub-config` skill), or run:

```sh
subhub on|off <sub>
subhub remove <sub>
subhub connect|disconnect <claude|codex|gemini|cursor|all>
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
  bin/subhub                      the engine (POSIX sh; plutil on macOS, python3 elsewhere)
install.sh                        one-line installer
SubHub/                           optional macOS app (setup + status)
```

## Requirements

macOS, or Linux with `python3`, plus at least two AI CLIs signed in. Each sub's usage counts against that subscription. Check each provider's terms on scripted use and on using several accounts.

MIT licence.
