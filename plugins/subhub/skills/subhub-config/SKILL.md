---
name: subhub-config
description: Change how the user's SubHub subs work - what each is used for, its default model, notes added to every brief, on/off, and the order to try them; also sign accounts in, add a team or personal organization, connect agents, and check status. Use only when the user asks to set up or change SubHub.
allowed-tools: Bash(subhub *)
---

# SubHub settings and setup

Start with `subhub status` (subs, agents, accounts found but not signed in) and `subhub config` (the settings file).

## Settings: `~/.subhub/config.json`
Edit only this file, with your file-edit tool so the user sees the change. Keep it strict JSON. Change only what the user asked; if it's unclear or names a sub that doesn't exist, ask first.

```json
{ "subs": { "gemini-1": { "on": true, "use_for": "Web research only", "model": "default", "notes": "Answer in bullet points." } },
  "order": ["codex-1", "claude-2"] }
```

| Field | Meaning |
|---|---|
| `on` | false: no agent uses it, and `subhub ask` refuses it |
| `use_for` | what agents should use it for, one sentence; empty = SubHub's default |
| `model` | used when an agent passes default; an id from `subhub models <sub>` (Claude: fable, opus, sonnet, haiku) |
| `notes` | added to every brief for this sub, under 2,000 characters |
| `order` | sub names, most preferred first |

Changes apply on the next `subhub ask` call.

## Accounts and agents (tell the user to run these in a terminal: sign-ins are interactive)
- Sign a sub in again: `subhub signin <sub>`
- Add another Claude account or organization (for example the team side of an email): `subhub signin claude --new --email you@company.com`, then pick the organization in the browser.
- Stop using a sub: `subhub remove <sub>`
- Connect or disconnect an agent: `subhub connect <claude|codex|gemini|cursor|all>`, `subhub disconnect …`
