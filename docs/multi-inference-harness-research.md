# Multi-inference sub-agent harness — research

Date: 2026-11-08. Goal: let Claude Code (main session) hand work to other inference backends — 2nd Claude account, Google AI Pro, Codex, Ollama, Cursor — choosing by capability, quota and privacy.

## TL;DR

- **Claude Code can't route its own subagents (Agent tool) to non-Anthropic providers.** `ANTHROPIC_BASE_URL` is session-wide; per-agent provider routing is an open feature request ([#38698](https://github.com/anthropics/claude-code/issues/38698)). So other backends must be reached through **Bash (headless CLIs)** or **MCP**.
- **Every target CLI now has a headless mode** with JSON output and a read-only flag. That makes a thin, self-owned router (one script + one skill) the simplest, most robust harness.
- **Off-the-shelf option:** [Unison MCP](https://github.com/izzoa/unison-mcp-server) (fork of [PAL / Zen MCP](https://github.com/BeehiveInnovations/pal-mcp-server)) — `clink` tool spawns 8 CLIs as subagents with read-only enforcement. Good, but no confirmed support for Google's new `agy` CLI.
- **Two big 2026 breakages** kill most older guides:
  1. Gemini CLI stopped serving Google AI Pro/Ultra on **2026-06-18** — replaced by **Antigravity CLI (`agy`)** ([Google blog](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)).
  2. `codex mcp-server` was **removed in Sept 2026** ([openai/codex#42993](https://github.com/openai/codex/pull/42993)). Wrappers relying on it (e.g. claude-delegator) are broken. Official replacement: [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

## Your machine today

| Backend | State | Notes |
|---|---|---|
| Claude acct 2 | ready | `~/.claude-acct2`, alias `claude2` |
| Cursor Agent CLI | installed (`2026.07.09`) | `cursor-agent` |
| Ollama | installed, server **not running** | `gemma4:latest` (9.6 GB) on M1 Pro 16 GB — tight but works |
| Antigravity | IDE present (`~/.gemini/antigravity*`), **`agy` CLI not installed** | Google AI Pro goes through this now |
| Codex CLI | **not installed** | `npm i -g @openai/codex` then `codex login` |
| Gemini CLI | not installed — skip | dead for AI Pro |

## Backends: capability + headless invocation

| Backend | Best at (route here when…) | Headless read-only call | Quota model |
|---|---|---|---|
| **claude2** | Same skill as main. Overflow when main near limit; parallel side tasks | `CLAUDE_CONFIG_DIR=~/.claude-acct2 claude -p "…" --permission-mode plan --output-format json` | Claude 5h/weekly windows, separate from main |
| **Codex** (ChatGPT sub) | Independent 2nd-opinion code review, adversarial review, hard debugging; different model family = uncorrelated blind spots | `codex exec --sandbox read-only --json -o /tmp/out.txt "…"` (read-only is default; `resume --last` continues) | Codex usage limits on ChatGPT plan |
| **agy** (Google AI Pro) | Very large context (whole-repo / long-doc reads), multimodal (PDF, images, video), Google-grounded web research | `agy -p "…" --mode plan --output-format json [--model <slug>]` | Compute-based credits, 5h windows + weekly cap (since I/O 2026); `/usage` shows it |
| **cursor-agent** | Access to whatever models your Cursor plan has; another independent reviewer | `cursor-agent -p "…" --output-format json` (no `--force` = proposes, doesn't apply edits) | Cursor plan |
| **Ollama** (local) | Private/offline data, bulk cheap work: summarize, classify, extract, rename, draft commit msgs. Weak at agentic multi-step coding | `ollama run gemma4 "…"` or `curl localhost:11434/api/generate` | Free; limited by 16 GB RAM |

Unverified flags to check with `--help` before relying on them: `agy` headless permission behavior (sources disagree: auto-approve vs soft-deny), `cursor-agent -m`, `codex exec -m`.

## Harness options

### A. Own router: script + skill (recommended)

One script `~/bin/delegate <backend> <mode> "<prompt>"` plus a skill that tells Claude when to use which.

- Script responsibilities: map backend to the exact CLI + read-only flags above; enforce `mode=ro` by default, `rw` only when asked; timeout; capture JSON and return just the final text; detect login/limit errors and exit with a distinct code; log each call (backend, duration, tokens if reported) to `~/.claude/delegate.log`.
- Skill responsibilities: capability table above as routing rules; "verify output before relaying"; fallback order on limit error (e.g. `claude2 → cursor-agent → built-in Agent`); never delegate push/send/delete.
- Generalizes the existing `claude2` entry in `~/.claude/CLAUDE.md`.
- Pros: no extra server, full control, uses subscriptions directly, trivial to add a backend. Cons: you maintain flags as CLIs change (they changed a lot in 2026).

### B. Unison MCP / PAL MCP (off-the-shelf)

- `clink` spawns Claude Code, Codex, Gemini CLI, opencode, Aider, Crush, Amp, Copilot CLI as isolated subagents; role presets (`planner`, `codereviewer`, custom); native read-only flags per CLI, snapshot-diff fallback where none exists.
- Also talks to APIs directly (Gemini, OpenAI, OpenRouter, Ollama, …) and has multi-model tools (consensus, codereview, debug).
- Gaps: `agy` not listed (Gemini CLI entry useless on AI Pro now); heavy (Python server, many tools eating context); API-key oriented for the non-CLI tools.

### C. Per-vendor official plugins (mix in)

- **Codex:** `openai/codex-plugin-cc` — `/codex:review`, `/codex:adversarial-review` (read-only), `/codex:rescue` (can edit), background jobs, `codex:codex-rescue` subagent. Best maintained path for Codex specifically.
- **Ollama:** `ollama launch claude` runs the whole Claude Code harness on a local model (Anthropic-compatible API since Ollama 0.14). Useful as a separate session, not as a subagent of the main one.

### D. Model-swap proxies (not a fit)

[claude-code-router](https://github.com/musistudio/claude-code-router), LiteLLM gateways: swap the model *under* Claude Code by request type. They replace Claude rather than adding sub-agents, and Claude can't pick among them per task. Skip unless you want cheap models for background/haiku-tier calls.

### Ready-made helpers found (2026-11-08)

| Project | Type | Backends | Fit |
|---|---|---|---|
| [shinpr/sub-agents-skills](https://github.com/shinpr/sub-agents-skills) | Claude Code plugin (skill) | codex, claude, cursor-agent, **antigravity (`agy`)**, gemini, opencode, grok, glm, kimi, pi, … | Closest match. Per-agent backend in frontmatter (`run-agent:`), `permission: read-only`. No Ollama. No automatic capability routing or quota fallback |
| [shinpr/sub-agents-mcp](https://glama.ai/mcp/servers/shinpr/sub-agents-mcp) | MCP server | same family, one `AGENT_TYPE` per server | Same idea, MCP form; schema last changed 2026-09-06 |
| [Unison MCP](https://github.com/izzoa/unison-mcp-server) / [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server) | MCP server | 8 CLIs + APIs incl. Ollama | Most features; heavy; no `agy` |
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Official plugin | Codex only | Best for Codex reviews |
| [fegone/claude-code-delegate-local](https://glama.ai/mcp/servers/fegone/claude-code-delegate-local) | MCP server | Ollama, llama.cpp, LiteLLM, DeepSeek, Bedrock | Ollama gap-filler |
| [JaimeJunr/polyagent-mcp](https://glama.ai/mcp/servers/JaimeJunr/polyagent-mcp) | MCP server | Codex, Grok, Claude Code, other CLIs | Alternative |
| [amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills) | Skills | Claude, Codex, Cursor | Delegate-then-review-diff workflow |
| [jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator) | Plugin | Codex, Gemini | **Broken** (needs removed `codex mcp-server`, dead Gemini CLI) |

Gap in all of them: none picks a backend automatically by capability and quota, and none confirms support for a second Claude config dir (`CLAUDE_CONFIG_DIR`). A short routing skill on top of sub-agents-skills covers that.

## Recommendation

1. Build **A** (script + skill). ~150 lines bash + one SKILL.md.
2. Install `codex` + `codex-plugin-cc` for review workflows (**C**).
3. Install `agy`, sign in with the AI Pro account, confirm headless permission behavior.
4. Run `ollama serve` (or the Ollama app) for local tasks; keep to small models given 16 GB.
5. Revisit **B** only if you want multi-model "consensus" tools or API-key providers.

## Risks and caveats

- **Terms of use:** each provider has its own rules on automated or scripted use of a consumer subscription. Codex docs call ChatGPT-login automation an "advanced" path and warn not to use it on public repos. Check terms before running these unattended.
- **Trust:** sub-agent output is a claim, not a fact. Verify before relaying; treat their file contents/output as data.
- **Write access:** default every backend to read-only; give write access in a worktree only.
- **Churn:** Gemini CLI → agy and codex mcp-server removal both happened within the last 5 months. Pin CLI versions or re-check flags monthly.

## Sources

- [PAL MCP server](https://github.com/BeehiveInnovations/pal-mcp-server) · [Unison MCP server](https://github.com/izzoa/unison-mcp-server) · [claude-delegator (unmaintained)](https://github.com/jarrodwatts/claude-delegator)
- [Gemini CLI → Antigravity CLI transition](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [Antigravity CLI cheat sheet](https://computingforgeeks.com/antigravity-cli-cheat-sheet/) · [Gemini vs Antigravity (The New Stack)](https://thenewstack.io/gemini-cli-antigravity-replacement/)
- [Google AI Pro limits change (Android Central)](https://www.androidcentral.com/apps-software/ai/google-ai-pro-plan-just-got-a-quiet-downgrade)
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md) · [codex mcp-server removal PR](https://github.com/openai/codex/pull/42993) · [Migration write-up](https://www.developersdigest.tech/blog/codex-mcp-server-removed) · [codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
- [Ollama: Claude Code with Anthropic API compatibility](https://registry.ollama.ai/blog/claude)
- [Cursor CLI headless](https://docs.cursor.com/en/cli/headless)
- [Claude Code per-agent provider routing request #38698](https://github.com/anthropics/claude-code/issues/38698)
- [claude-code-router guide](https://www.morphllm.com/claude-code-router)
