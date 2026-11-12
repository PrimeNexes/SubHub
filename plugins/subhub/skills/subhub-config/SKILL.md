---
name: subhub-config
description: Change how the user's SubHub subs work - what each is used for, its default model, notes added to every brief, on/off, and the order to try them; also sign accounts in, add a team or personal organization, connect agents, and check status. Use only when the user asks to set up or change SubHub.
allowed-tools: Bash(subhub *)
---

# SubHub settings and setup

Start with `subhub status` (subs and their health, agents, accounts found but not signed in, and a warning if the `subhub` on PATH is a different version from the plugin) and `subhub config` (the settings file).

## Which subs actually work
- `subhub status` shows each sub's health: working, at its usage limit (until when), out of credits or no plan, not authorised for headless runs, failing, or unknown. SubHub learns it for free from every real `subhub ask`.
- `subhub check [sub…]` re-tests them: free CLI checks first (sign-in, Codex rate limits, Ollama's API), then one tiny test prompt per sub where those can't tell. That prompt uses a little of the sub's usage, so run it only when the user asks. `subhub list --refresh` and `subhub install` do the same (`subhub install --no-check` skips it).
- A sub at its limit is skipped until its reset time, then tried again. `subhub ask --force <sub> …` tries a sub SubHub thinks is at its limit or out of credits anyway.
- If status warns about a version mismatch, the fix is `subhub install` from the newer copy (the warning names the command).

## Settings: `~/.subhub/config.json`
Edit only this file, with your file-edit tool so the user sees the change. Keep it strict JSON. Change only what the user asked; if it's unclear or names a sub that doesn't exist, ask first.

```json
{ "subs": { "gemini-1": { "on": true, "use_for": "Web research only", "model": "default", "notes": "Answer in bullet points." } },
  "order": ["codex-1", "claude-2"], "notes": "Answer tersely.", "hook": true }
```

| Field | Meaning |
|---|---|
| `on` | false: no agent uses it, and `subhub ask` refuses it |
| `use_for` | what agents should use it for, one sentence; empty = SubHub's default |
| `model` | used when an agent passes default; an id from `subhub models <sub>` (Claude: fable, opus, sonnet, haiku) |
| `notes` | added to every brief for this sub, under 2,000 characters |
| `order` | sub names, most preferred first |
| `notes` (top level) | added to every brief for every sub, follow-ups included. Use it for rules all subs should follow, such as an answer style (terse "caveman" replies). Sub hooks are off, so a style plugin in the sub's own agent doesn't load: put the style here |
| `hook` | Claude Code only. false: turns off the redirect hook that sends generic built-in sub-agents (general-purpose, Explore) to the `subhub:relay` agent. Default on. `SUBHUB_HOOK=0` in the environment also turns it off |
| `hook_types` | Claude Code only. The sub-agent types the hook redirects, replacing the default `["general-purpose", "Explore", "claude", ""]` (`""` = a call with no type) |

Changes apply on the next `subhub ask` call.

## Accounts and agents (tell the user to run these in a terminal: sign-ins are interactive)
- Sign a sub in again: `subhub signin <sub>`
- Add another Claude account or organization (for example the team side of an email): `subhub signin claude --new --email you@company.com`, then pick the organization in the browser.
- Stop using a sub: `subhub remove <sub>`
- Connect or disconnect an agent: `subhub connect <claude|codex|gemini|cursor|all>`, `subhub disconnect …`
- Connecting also adds a short always-on rule (between `<!-- subhub:start` and `<!-- subhub:end -->`) to that agent's global rules file, so it uses subs before built-in sub-agents: `~/.claude/CLAUDE.md`, Codex's `AGENTS.md`, `~/.gemini/config/AGENTS.md`; Cursor has none. `subhub status` shows where. To connect without it: `subhub connect <agent> --no-rules`. To remove it: `subhub disconnect <agent>`, or delete the marked lines. Don't edit inside the markers: the next connect replaces them.
