# Session Economics — Phase 2 Design Spec

**Date**: 2026-04-08
**Issue**: #55
**Depends on**: Phase 1 decision event detection (completed in #55)

## Goal

Add time-awareness and economic scoring to pulse reports. A session becomes a P&L statement: decisions and outcomes produced (yield) vs. tokens, time, and rework consumed (cost). The headline metric is **Session ROI** — a composite that tells the user whether a session was productive relative to its cost.

## Architecture

**Approach C**: New extractor for time/economics, ROI composite in orchestrator.

```
extractSessionEconomics(sessionPath, tokenUsage, convergence, pricing?)
  → SessionEconomicsSignal

computeSessionROI(convergence, economics, decisionQuality)
  → { score, label }
```

- `session-economics.ts` owns time analysis (duration, active/idle, thrashing) and cost modeling (token pricing)
- `pulse.ts` computes the ROI composite by combining economics with existing convergence + decision signals — same pattern as `computeLeverage()`
- Each extractor stays focused on one concern; the orchestrator composes

## Types

### SessionEconomicsSignal

```typescript
interface SessionEconomicsSignal {
  /** Wall-clock duration from first to last message (ms) */
  durationMs: number;
  /** Time spent with active exchanges — messages < 5min apart (ms) */
  activeMs: number;
  /** Estimated idle time — sum of gaps > 5min (ms) */
  idleMs: number;
  /** Number of idle gaps detected */
  idleGaps: number;

  /** Thrashing episodes: stretches of exchanges with no decision events */
  thrashingEpisodes: ThrashingEpisode[];

  /** Token cost in dollars (null if model pricing unavailable) */
  costDollars: number | null;
  /** Tokens spent per decision event (Infinity if 0 decisions) */
  tokensPerDecision: number;
  /** Tokens estimated burned during thrashing episodes */
  thrashingTokens: number;
}

interface ThrashingEpisode {
  /** Exchange range (inclusive, 0-based) */
  startExchange: number;
  endExchange: number;
  /** Number of exchanges in this episode */
  exchanges: number;
  /** Estimated tokens consumed — proportional allocation */
  estimatedTokens: number;
}
```

### ModelPricing

```typescript
interface ModelPricing {
  inputPerMTok: number;   // $ per million input tokens
  outputPerMTok: number;  // $ per million output tokens
}
```

## Extractor: session-economics.ts

### Inputs

| Parameter | Source | Required |
|-----------|--------|----------|
| `sessionPath` | CLI / findSessionFile | yes |
| `tokenUsage: TokenUsageSignal` | token-usage extractor | yes |
| `convergence: ConvergenceSignal` | convergence extractor | yes |

### Time Analysis

Scan all message timestamps in the session JSONL:
- **durationMs**: last timestamp minus first timestamp
- **Idle detection**: any gap > 5 minutes between consecutive messages counts as idle. Sum of all idle gaps = `idleMs`. Count = `idleGaps`.
- **activeMs**: `durationMs - idleMs`

Works without MPG data — pure session JSONL timestamp analysis.

### Thrashing Detection

Scan exchange indices against `convergence.decisionEvents`:
- Build a set of exchange indices that have decision events
- Walk exchanges 0..N. Any sequence of **4+ consecutive exchanges** with no decision event in the range is a thrashing episode. If a session has zero decision events, the entire session is one thrashing episode only if it has 4+ exchanges (avoids flagging short exploratory sessions).
- Episode token cost: `(episode.exchanges / convergence.exchanges) * tokenUsage.totalTokens`
- Sum all episode tokens = `thrashingTokens`

### Dollar Cost Model

**Pricing table** (hardcoded constant, no external config):

| Model prefix | Input $/MTok | Output $/MTok |
|---|---|---|
| `claude-opus-4` | 15 | 75 |
| `claude-sonnet-4` | 3 | 15 |
| `claude-haiku-4` | 0.80 | 4 |

**Model detection**: scan session JSONL assistant messages for the `model` field. Claude Code sessions include this. Use prefix matching for version suffixes (e.g., `claude-opus-4-6` matches `claude-opus-4`).

**Blended cost**: if multiple models appear (e.g., haiku subagents + opus main), sum per-message costs individually rather than applying a single rate.

**Graceful degradation**: if no model field found in session, `costDollars = null`. Report omits the cost line.

### tokensPerDecision

```
decisionCount = convergence.decisionEvents?.length ?? 0
tokensPerDecision = decisionCount > 0
  ? totalTokens / decisionCount
  : Infinity
```

Display as `Infinity` → "no decisions detected" in report.

## ROI Composite: computeSessionROI()

Lives in `pulse.ts` alongside `computeLeverage()`.

### Formula

```
Yield = decisionDensity * 0.4 + outcomeDensity * 0.3 + convergenceEfficiency * 0.3
  decisionDensity      = min(decisions / max(exchanges, 1), 1)
  outcomeDensity       = min(outcomes / max(exchanges, 1), 1)
  convergenceEfficiency = 1 / (1 + rate)

Cost = tokenBurn * 0.4 + timeCost * 0.3 + instability * 0.3
  tokenBurn    = min(tokensPerDecision / 50000, 1)   // 50k = cost ceiling
  timeCost     = min(idleMs / max(durationMs, 1), 1) // idle fraction
  instability  = reworkPercent/100 + min(thrashingEpisodes.length * 0.15, 0.45)

ROI = Yield / max(Cost, 0.1)   // floor to avoid division by zero
```

### Labels

| ROI | Label |
|-----|-------|
| >= 1.5 | PRODUCTIVE |
| >= 0.8 | NEUTRAL |
| < 0.8 | EXPENSIVE |

## Report Format

New section after TOKEN CORRELATION:

```
SESSION ECONOMICS
  Duration:              47m (38m active, 9m idle)
  Decisions:             5 detected (12.4k tokens/decision)
  Thrashing:             1 episode (exchanges 3-8, ~28k tokens)
  Cost:                  $1.23 (estimated)
  Session ROI:           1.82 (PRODUCTIVE)
```

- "Cost" line only appears when `costDollars !== null`
- "Thrashing" line only appears when episodes > 0
- Duration formatted as `Xh Ym` or `Xm` depending on length

### Summary line update

```
──────────────────────────────────────────────────
Interaction Leverage:    0.64 (MEDIUM)
Session ROI:             1.82 (PRODUCTIVE)
──────────────────────────────────────────────────
```

Both metrics appear. Leverage = interaction quality (steering). ROI = economics (cost vs. yield).

## PulseReport Changes

Add to `PulseReport` interface:
```typescript
sessionEconomics: SessionEconomicsSignal;
sessionROI: number;
sessionROILabel: "PRODUCTIVE" | "NEUTRAL" | "EXPENSIVE";
```

## Orchestration Changes (runPulse)

```typescript
// After existing extractors:
const sessionEconomics = extractSessionEconomics(sessionFile, tokenUsage, convergence);
const { score: sessionROI, label: sessionROILabel } = computeSessionROI(convergence, sessionEconomics, decisionQuality);
```

## Aggregate Changes (runThreadPulse)

For multi-agent thread reports:
- Sum `durationMs`, `activeMs`, `idleMs`, `idleGaps` across agents
- Concatenate `thrashingEpisodes`
- Sum `costDollars` (null if any agent is null)
- Recompute `tokensPerDecision` from aggregate totals
- Recompute ROI from aggregate signals

## Testing

- **Time analysis**: session JSONL with known gaps → verify active/idle split
- **Thrashing detection**: session with decisions at known exchanges → verify episode boundaries
- **Dollar cost**: session with known model field → verify cost calculation
- **Graceful degradation**: session without model field → costDollars is null
- **ROI scoring**: synthetic signals → verify formula produces expected scores and labels
- **Zero/edge cases**: empty session, single message, no decisions, all idle

## Non-goals

- No external config file for pricing — hardcoded table, update when new models ship
- No historical ROI trending — out of scope for Phase 2 (leverage trending already exists)
- No per-agent ROI in thread mode — aggregate only for now
