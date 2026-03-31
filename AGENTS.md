# Agent Guidance

This repository uses **IntentLayer intent-driven development**.

Authoritative files:
- `INTENTS.md` — declared system intents
- `intentlayer/signals/` — recorded signals
- `intentlayer/audits/` — audit writeups

Shared IntentLayer skills are available under `.agent/skills/`.

## Agents

### Pulse CLI
The primary agent is the Pulse CLI itself (`bin/pulse.js`). It reads Claude Code session data and git history to compute interaction quality metrics. It operates read-only on project files (I-002) and writes only to `.pulse/` and stdout.

## Rules
- Treat system intents as constraints
- Read `INTENTS.md` before making changes
- Apply IntentLayer skills when requested
- Never modify intent or signal files unless explicitly instructed
- Propose risks or uncertainty rather than deciding
- If unsure, state the uncertainty explicitly
- Reference intent IDs (e.g. `I-001`) in commit messages when changes relate to an intent
<!-- IntentLayer — added by intentlayer init -->
