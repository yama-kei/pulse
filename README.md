# Pulse

Agent interaction quality measurement — convergence, intent anchoring, decision quality.

Pulse measures how well you interact with AI agents, not how many tokens you consume. It's a mirror, not a surveillance tool.

## What It Measures

| Signal | Question | Source |
|--------|----------|--------|
| **Convergence** | How many exchanges to reach an outcome? | Claude Code session logs |
| **Intent Anchoring** | Are declared intents referenced during work? | INTENTS.md, CLAUDE.md, git history |
| **Decision Quality** | Do commits explain "why", not just "what"? | git log |

## Install

```bash
npm install -g pulse-ai
```

Or run directly:

```bash
npx pulse-ai
```

## Usage

```bash
# Run a pulse on the current project
pulse

# Run against a specific directory
pulse run /path/to/project

# Output raw JSON alongside the report
pulse run --json

# Don't save the pulse report
pulse run --no-save
```

## Output

```
Pulse — HouseholdOS
══════════════════════════════════════════════════
2026-03-26T06:14:01Z | 7 exchanges | 11 outcomes

CONVERGENCE
  Exchanges to outcome:  0.64 (excellent)
  Rework instances:      0 (0%)

INTENT ANCHORING
  INTENTS.md:            present
  Declared intents:      6
    I-001: AI-Accessible Household Knowledge [At Risk]
    I-002: Tenant Data Isolation [Earned]
  Referenced in commits: none
  Gap:                   I-001, I-002 declared but not referenced

DECISION QUALITY
  Commits:               85
  Reference "why":       4/85
  Link to issues:        4/85

──────────────────────────────────────────────────
Interaction Leverage:    HIGH
──────────────────────────────────────────────────

OBSERVATIONS
  - 6 intent(s) declared but not referenced in commits. Consider reviewing intent alignment.
```

## How It Works

- **No setup required** — works on any git repository
- **INTENTS.md optional** — degrades gracefully using git log and CLAUDE.md
- **Local only** — pulse reports saved to `.pulse/` (gitignored by default)
- **No LLM in scoring** — all metrics computed from observable data
- **Transparent** — you see everything Pulse computes

## Requirements

- Node.js >= 18
- Git

## License

MIT
