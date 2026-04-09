# Session Economics — Decision-Oriented Quality Measurement

**Date:** 2026-04-02
**Issue:** #52
**Status:** Approved

## Problem

Token usage is becoming a proxy metric for AI-assisted engineering productivity (Big Tech ranking engineers by token consumption). But tokens measure search cost, not value. The same token count can represent deep debugging loops (low productivity) or a full feature shipped (high productivity). Pulse already measures convergence, intent anchoring, and decision quality — this design extends it to directly measure **decision economics**: the ratio of resolved decisions to invested cost.

## Design

Three incremental phases, each shippable independently.

---

### Phase 1: Decision Event Detection

A new extractor that auto-detects "decision events" from session JSONL — moments where uncertainty is resolved and forward progress is locked in.

#### Detection Heuristics

Events are inferred from tool-use sequences and conversation structure:

| Pattern | Event Type | Confidence |
|---|---|---|
| Reads/greps -> targeted edit -> commit (no rework after) | `implementation_decided` | high |
| Exploration phase -> pivot to edit -> `fix:` commit | `root_cause_identified` | high |
| File edited then untouched for session remainder | `schema_locked` | medium |
| `feat:` commit + PR created | `feature_shipped` | high |
| Multiple reads across alternatives -> single path committed | `design_chosen` | medium |
| Commit with `fix:` + issue reference | `bug_resolved` | high |

Heuristics start conservative — honest undercounting is better than noise. Rules evolve iteratively as real session data reveals new patterns. Confidence scoring ensures low-confidence events contribute less to metrics.

#### New Type

```typescript
interface DecisionEvent {
  type: 'implementation_decided' | 'root_cause_identified' | 'schema_locked'
      | 'contract_finalized' | 'feature_shipped' | 'bug_resolved' | 'design_chosen';
  timestamp: string;
  confidence: 'high' | 'medium' | 'low';
  relatedFiles: string[];
  tokensCost: number;  // tokens consumed since last decision
}
```

#### New Extractor

`src/extractors/decision-events.ts`

- Parses tool-use entries from session JSONL (reuses convergence extractor's parsing logic)
- Builds a timeline of file touches (read, edit, write, commit)
- Applies pattern matching over the timeline to emit `DecisionEvent[]`

#### Headline Metric

`tokensPerDecision = totalTokens / decisionCount`

---

### Phase 2: Session Economics (Time + ROI)

#### Time-Awareness

Parsed from JSONL timestamps (already present in every entry):

- `sessionDuration`: first -> last message
- `activeTime`: time excluding idle gaps (>5 min gap = idle)
- `idleTime`: sessionDuration - activeTime

New extractor: `src/extractors/session-time.ts`

#### Thrashing Detection

When `iterations > N` with no decision event detected between them, pulse flags a thrashing episode. Natural byproduct of having both iteration counts (from convergence) and decision events (from Phase 1).

#### Session ROI Composite

```
Yield Score = weighted sum of:
  - decisionCount          (0.40)  <- Phase 1
  - outcomeCount           (0.30)  <- existing (commits, PRs, files)
  - convergenceEfficiency  (0.30)  <- existing (inverse of rate)

Cost Score = weighted sum of:
  - totalTokens (normalized)  (0.40)
  - activeTime (normalized)   (0.30)
  - reworkCount (normalized)  (0.30)

Session ROI = Yield Score / Cost Score
```

Labels: `HIGHLY PRODUCTIVE` (>=0.80), `PRODUCTIVE` (>=0.55), `MODERATE` (>=0.35), `LOW YIELD` (<0.35).

#### New Report Section

```
SESSION ECONOMICS
  Duration:     47m (38m active, 9m idle)
  Decisions:    5 detected (12.4k tokens/decision)
  Thrashing:    1 episode (14 iterations, 0 decisions)
  Session ROI:  0.72 (PRODUCTIVE)
```

Session ROI replaces Interaction Leverage as the headline metric. Existing Leverage score kept as a sub-component for backwards compatibility.

---

### Phase 3: Open `pulse-event` Protocol

#### Event Schema (`pulse-event/v1`)

```json
{
  "schema": "pulse-event/v1",
  "type": "decision_event",
  "subtype": "root_cause_identified",
  "timestamp": "2026-04-02T10:23:00Z",
  "session_id": "abc123",
  "confidence": "high",
  "tokens_since_last": 12400,
  "related_files": ["src/auth.ts"],
  "source": "pulse"
}
```

Design choices:
- **Source-agnostic**: `source` field identifies the producer (`pulse`, `mpg`, `custom-script`, etc.)
- **Versioned**: `pulse-event/v1` allows evolution without breaking consumers
- **File-based**: Events go to `~/.pulse/events/{source}.jsonl` — any tool that can append a line is a producer
- **Extensible**: Unknown event types are preserved but ignored by current analysis

#### Event Types

- `decision_event` — uncertainty resolved (subtypes from Phase 1)
- `session_start` / `session_end` — session lifecycle
- `thrashing_detected` — flagged episode
- `rework_detected` — undo/correction cycle

#### Producers

- **Pulse**: Auto-detection writes to `~/.pulse/events/pulse.jsonl`
- **MPG**: Adopts `pulse-event/v1` envelope over existing `mpg-sessions.jsonl` format
- **Third-party**: Any tool that appends conforming JSON lines

#### New CLI

- `pulse export [--session <id>]` — bundles session analysis + event timeline into a shareable JSON report

---

## What Changes in Existing CLI

- `pulse run` gains Decision Events and Session Economics sections — no new flags needed
- `pulse trend` and `pulse compare` gain new metrics automatically (they read from saved reports)
- `pulse export` — new command

## What Doesn't Change

- Zero production dependencies
- All local, no cloud
- Existing extractors untouched — new ones layer on top
- `--no-llm` still works (all new features are heuristic-based)
- Graceful degradation (missing data = zero/empty signals, never errors)

## Strategic Trajectory

1. **Phase 1**: Individual devs get "am I steering well?" metric
2. **Phase 2**: Sessions become economically legible — cost vs. yield
3. **Phase 3**: Open protocol positions pulse as community standard for human-AI collaboration quality measurement
