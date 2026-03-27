# Pulse

Agent interaction quality measurement tool. Analyzes convergence, intent anchoring, decision quality, and interaction patterns from Claude Code sessions.

## Build & Test

```bash
npm run build    # TypeScript → dist/
npm test         # Compile + run all tests
```

Tests use Node.js built-in test runner (`node:test` + `node:assert`). Test files live alongside source: `src/extractors/*.test.ts`.

## Project Structure

```
src/
  cli.ts                        # Entry point, command parsing
  types/pulse.ts                # All type definitions
  commands/pulse.ts             # Orchestration: runPulse(), formatReport(), savePulse()
  extractors/
    convergence.ts              # Exchange efficiency from session JSONL
    intent-anchoring.ts         # INTENTS.md/CLAUDE.md alignment
    decision-quality.ts         # Commit message quality
    interaction-pattern.ts      # User style + context provision classification
bin/
  pulse.js                      # Shebang wrapper → dist/cli.js
```

## Conventions

- Zero production dependencies. Only TypeScript + @types/node for dev.
- All extractors follow the same pattern: export a single `extract*()` function that takes project/session data and returns a typed signal.
- Extractors degrade gracefully — missing files or non-git dirs produce zero/empty signals, never errors.
- No external LLM in scoring. All metrics computed from observable data (git, session logs, file patterns).
- Reports saved locally to `.pulse/` directory. No cloud storage.
- TypeScript strict mode. Target ES2022, CommonJS output.
- Import paths use `.js` extension (for compiled output compatibility).

## Key Thresholds

- Convergence rate: ≤0.5 excellent, ≤1.5 good, ≤4 moderate, >4 high
- Leverage: HIGH (rate≤1 + rework<10%), LOW (rate>4 or rework>15%), else MEDIUM
- Rework nudge triggers at >15%
- Exchanges nudge triggers at >4 per outcome
