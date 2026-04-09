# Session Economics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add time-awareness and economic scoring (Session ROI) to pulse reports, measuring decision yield against token/time cost.

**Architecture:** New extractor `session-economics.ts` computes time analysis (duration, active/idle, thrashing) and dollar cost. ROI composite computed in `pulse.ts` alongside existing `computeLeverage()`. Each extractor stays focused; orchestrator composes.

**Tech Stack:** TypeScript, Node.js built-in test runner, zero dependencies.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types/pulse.ts` | Modify | Add `SessionEconomicsSignal`, `ThrashingEpisode`, `ModelPricing` types; extend `PulseReport` |
| `src/extractors/session-economics.ts` | Create | Time analysis, thrashing detection, dollar cost calculation |
| `src/extractors/session-economics.test.ts` | Create | Tests for all extractor logic |
| `src/commands/pulse.ts` | Modify | Add `computeSessionROI()`, wire extractor in `runPulse()`, format report section, update `aggregateReports()` |
| `src/commands/pulse.test.ts` | Modify | Add ROI scoring tests |

---

### Task 1: Add types to pulse.ts

**Files:**
- Modify: `src/types/pulse.ts`

- [ ] **Step 1: Add SessionEconomicsSignal, ThrashingEpisode, and ModelPricing types**

Add after the `DecisionQualitySignal` interface (after line 212):

```typescript
export interface SessionEconomicsSignal {
  /** Wall-clock duration from first to last message (ms) */
  durationMs: number;
  /** Time spent with active exchanges — messages < 5min apart (ms) */
  activeMs: number;
  /** Estimated idle time — sum of gaps > 5min (ms) */
  idleMs: number;
  /** Number of idle gaps detected */
  idleGaps: number;
  /** Thrashing episodes: stretches of 4+ exchanges with no decision events */
  thrashingEpisodes: ThrashingEpisode[];
  /** Token cost in dollars (null if model pricing unavailable) */
  costDollars: number | null;
  /** Tokens spent per decision event */
  tokensPerDecision: number;
  /** Tokens estimated burned during thrashing episodes */
  thrashingTokens: number;
}

export interface ThrashingEpisode {
  /** Exchange range start (inclusive, 0-based) */
  startExchange: number;
  /** Exchange range end (inclusive, 0-based) */
  endExchange: number;
  /** Number of exchanges in this episode */
  exchanges: number;
  /** Estimated tokens consumed — proportional allocation */
  estimatedTokens: number;
}

export interface ModelPricing {
  /** Dollars per million input tokens */
  inputPerMTok: number;
  /** Dollars per million output tokens */
  outputPerMTok: number;
}
```

- [ ] **Step 2: Extend PulseReport interface**

Add three new fields to the `PulseReport` interface:

```typescript
export interface PulseReport {
  // ... existing fields ...
  interactionLeverage: "HIGH" | "MEDIUM" | "LOW";
  leverageScore: number;
  sessionEconomics: SessionEconomicsSignal;
  sessionROI: number;
  sessionROILabel: "PRODUCTIVE" | "NEUTRAL" | "EXPENSIVE";
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Type errors in `pulse.ts` because `runPulse()` and `aggregateReports()` don't return the new fields yet. This is expected — we'll fix them in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/types/pulse.ts
git commit -m "feat(types): add SessionEconomicsSignal and extend PulseReport (#55)"
```

---

### Task 2: Create session-economics extractor — time analysis

**Files:**
- Create: `src/extractors/session-economics.ts`
- Create: `src/extractors/session-economics.test.ts`

- [ ] **Step 1: Write failing tests for time analysis**

Create `src/extractors/session-economics.test.ts`:

```typescript
import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { extractSessionEconomics } from "./session-economics.js";
import { TokenUsageSignal, ConvergenceSignal } from "../types/pulse.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createSessionFile(entries: Array<{ type: string; timestamp: string; model?: string; input_tokens?: number; output_tokens?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-econ-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  const lines = entries.map(e => {
    const obj: any = { type: e.type, timestamp: e.timestamp };
    if (e.type === "user") {
      obj.message = { role: "user", content: "test message" };
    } else {
      obj.message = { role: "assistant", content: "response" };
      if (e.model) obj.message.model = e.model;
      if (e.input_tokens !== undefined || e.output_tokens !== undefined) {
        obj.message.usage = {
          input_tokens: e.input_tokens ?? 0,
          output_tokens: e.output_tokens ?? 0,
        };
      }
    }
    return JSON.stringify(obj);
  });
  writeFileSync(filePath, lines.join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

function makeTokenUsage(overrides?: Partial<TokenUsageSignal>): TokenUsageSignal {
  return {
    inputTokens: 10000,
    outputTokens: 5000,
    totalTokens: 15000,
    tokensPerExchange: 3000,
    tokensPerOutcome: 5000,
    available: true,
    ...overrides,
  };
}

function makeConvergence(overrides?: Partial<ConvergenceSignal>): ConvergenceSignal {
  return {
    exchanges: 5,
    outcomes: 3,
    rate: 1.67,
    reworkInstances: 0,
    reworkPercent: 0,
    duplicateCommits: 0,
    blindRetries: 0,
    pivot: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of tmpDirs) { try { rmdirSync(d); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

describe("extractSessionEconomics — time analysis", () => {
  it("computes duration from first to last timestamp", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
      { type: "user", timestamp: "2026-04-08T10:10:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:11:00.000Z" },
    ]);
    const result = extractSessionEconomics(session, makeTokenUsage(), makeConvergence({ exchanges: 2 }));
    assert.equal(result.durationMs, 11 * 60 * 1000); // 11 minutes
  });

  it("detects idle gaps > 5 minutes", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
      // 10 minute gap (idle)
      { type: "user", timestamp: "2026-04-08T10:11:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:12:00.000Z" },
    ]);
    const result = extractSessionEconomics(session, makeTokenUsage(), makeConvergence({ exchanges: 2 }));
    assert.equal(result.idleGaps, 1);
    assert.equal(result.idleMs, 10 * 60 * 1000); // 10 minutes idle
    assert.equal(result.activeMs, 2 * 60 * 1000); // 2 minutes active
  });

  it("does not flag gaps <= 5 minutes as idle", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
      { type: "user", timestamp: "2026-04-08T10:04:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:05:00.000Z" },
    ]);
    const result = extractSessionEconomics(session, makeTokenUsage(), makeConvergence({ exchanges: 2 }));
    assert.equal(result.idleGaps, 0);
    assert.equal(result.idleMs, 0);
  });

  it("returns zero duration for null session path", () => {
    const result = extractSessionEconomics(null, makeTokenUsage(), makeConvergence());
    assert.equal(result.durationMs, 0);
    assert.equal(result.activeMs, 0);
    assert.equal(result.idleMs, 0);
  });

  it("handles single-message session", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
    ]);
    const result = extractSessionEconomics(session, makeTokenUsage(), makeConvergence({ exchanges: 1 }));
    assert.equal(result.durationMs, 0);
    assert.equal(result.idleMs, 0);
    assert.equal(result.activeMs, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: FAIL — `session-economics.js` does not exist yet.

- [ ] **Step 3: Implement time analysis in session-economics.ts**

Create `src/extractors/session-economics.ts`:

```typescript
import { SessionEconomicsSignal, ThrashingEpisode, TokenUsageSignal, ConvergenceSignal, ModelPricing } from "../types/pulse.js";
import { readFileSync } from "node:fs";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Extract session economics signal: time analysis, thrashing detection, dollar cost.
 */
export function extractSessionEconomics(
  sessionPath: string | null,
  tokenUsage: TokenUsageSignal,
  convergence: ConvergenceSignal
): SessionEconomicsSignal {
  const empty: SessionEconomicsSignal = {
    durationMs: 0,
    activeMs: 0,
    idleMs: 0,
    idleGaps: 0,
    thrashingEpisodes: [],
    costDollars: null,
    tokensPerDecision: Infinity,
    thrashingTokens: 0,
  };

  if (!sessionPath) return empty;

  const timestamps = readTimestamps(sessionPath);
  const { durationMs, activeMs, idleMs, idleGaps } = analyzeTime(timestamps);
  const thrashingEpisodes = detectThrashing(convergence, tokenUsage);
  const thrashingTokens = thrashingEpisodes.reduce((s, e) => s + e.estimatedTokens, 0);
  const costDollars = computeCost(sessionPath, tokenUsage);
  const decisionCount = convergence.decisionEvents?.length ?? 0;
  const tokensPerDecision = decisionCount > 0 ? Math.round(tokenUsage.totalTokens / decisionCount) : Infinity;

  return {
    durationMs,
    activeMs,
    idleMs,
    idleGaps,
    thrashingEpisodes,
    costDollars,
    tokensPerDecision,
    thrashingTokens,
  };
}

function readTimestamps(sessionPath: string): number[] {
  const timestamps: number[] = [];
  try {
    const content = readFileSync(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.timestamp) {
          timestamps.push(new Date(msg.timestamp).getTime());
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // unreadable
  }
  return timestamps;
}

function analyzeTime(timestamps: number[]): { durationMs: number; activeMs: number; idleMs: number; idleGaps: number } {
  if (timestamps.length < 2) {
    return { durationMs: 0, activeMs: 0, idleMs: 0, idleGaps: 0 };
  }
  const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
  let idleMs = 0;
  let idleGaps = 0;

  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > IDLE_THRESHOLD_MS) {
      idleMs += gap;
      idleGaps++;
    }
  }

  const activeMs = durationMs - idleMs;
  return { durationMs, activeMs, idleMs, idleGaps };
}

/** Placeholder — implemented in Task 3 */
function detectThrashing(convergence: ConvergenceSignal, tokenUsage: TokenUsageSignal): ThrashingEpisode[] {
  return [];
}

/** Placeholder — implemented in Task 4 */
function computeCost(sessionPath: string, tokenUsage: TokenUsageSignal): number | null {
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: All 5 time analysis tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extractors/session-economics.ts src/extractors/session-economics.test.ts
git commit -m "feat: add session-economics extractor with time analysis (#55)"
```

---

### Task 3: Add thrashing detection

**Files:**
- Modify: `src/extractors/session-economics.ts`
- Modify: `src/extractors/session-economics.test.ts`

- [ ] **Step 1: Write failing tests for thrashing detection**

Append to `session-economics.test.ts`:

```typescript
describe("extractSessionEconomics — thrashing detection", () => {
  it("detects thrashing when 4+ exchanges have no decisions", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:00:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:01:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:02:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:02:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:03:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:03:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:04:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:04:30.000Z" },
    ]);
    // 5 exchanges, decisions only at exchange 0
    const convergence = makeConvergence({
      exchanges: 5,
      decisionEvents: [{ atExchange: 0, type: "approved", detail: "yes" }],
    });
    const result = extractSessionEconomics(session, makeTokenUsage({ totalTokens: 50000 }), convergence);
    assert.equal(result.thrashingEpisodes.length, 1);
    assert.equal(result.thrashingEpisodes[0].startExchange, 1);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
    assert.equal(result.thrashingEpisodes[0].exchanges, 4);
    // 4/5 of total tokens = 40000
    assert.equal(result.thrashingEpisodes[0].estimatedTokens, 40000);
    assert.equal(result.thrashingTokens, 40000);
  });

  it("does not flag thrashing for sequences < 4 exchanges", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:00:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:01:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:30.000Z" },
      { type: "user", timestamp: "2026-04-08T10:02:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:02:30.000Z" },
    ]);
    // 3 exchanges, decision at exchange 0
    const convergence = makeConvergence({
      exchanges: 3,
      decisionEvents: [{ atExchange: 0, type: "approved", detail: "yes" }],
    });
    const result = extractSessionEconomics(session, makeTokenUsage(), convergence);
    assert.equal(result.thrashingEpisodes.length, 0);
  });

  it("detects multiple thrashing episodes separated by decisions", () => {
    const session = createSessionFile(
      Array.from({ length: 20 }, (_, i) => [
        { type: "user" as const, timestamp: `2026-04-08T10:${String(i).padStart(2, "0")}:00.000Z` },
        { type: "assistant" as const, timestamp: `2026-04-08T10:${String(i).padStart(2, "0")}:30.000Z` },
      ]).flat()
    );
    // 10 exchanges: decisions at 0 and 5 — gaps at 1-4 and 6-9
    const convergence = makeConvergence({
      exchanges: 10,
      decisionEvents: [
        { atExchange: 0, type: "approved", detail: "yes" },
        { atExchange: 5, type: "delegated", detail: "go" },
      ],
    });
    const result = extractSessionEconomics(session, makeTokenUsage({ totalTokens: 100000 }), convergence);
    assert.equal(result.thrashingEpisodes.length, 2);
    assert.equal(result.thrashingEpisodes[0].startExchange, 1);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
    assert.equal(result.thrashingEpisodes[1].startExchange, 6);
    assert.equal(result.thrashingEpisodes[1].endExchange, 9);
  });

  it("flags entire session as thrashing if 0 decisions and 4+ exchanges", () => {
    const session = createSessionFile(
      Array.from({ length: 10 }, (_, i) => [
        { type: "user" as const, timestamp: `2026-04-08T10:${String(i).padStart(2, "0")}:00.000Z` },
        { type: "assistant" as const, timestamp: `2026-04-08T10:${String(i).padStart(2, "0")}:30.000Z` },
      ]).flat()
    );
    const convergence = makeConvergence({ exchanges: 5, decisionEvents: undefined });
    const result = extractSessionEconomics(session, makeTokenUsage(), convergence);
    assert.equal(result.thrashingEpisodes.length, 1);
    assert.equal(result.thrashingEpisodes[0].startExchange, 0);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
  });

  it("no thrashing if 0 decisions and < 4 exchanges", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:00:30.000Z" },
    ]);
    const convergence = makeConvergence({ exchanges: 1, decisionEvents: undefined });
    const result = extractSessionEconomics(session, makeTokenUsage(), convergence);
    assert.equal(result.thrashingEpisodes.length, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: FAIL — thrashing tests fail because `detectThrashing` returns `[]`.

- [ ] **Step 3: Implement detectThrashing**

Replace the `detectThrashing` placeholder in `session-economics.ts`:

```typescript
function detectThrashing(convergence: ConvergenceSignal, tokenUsage: TokenUsageSignal): ThrashingEpisode[] {
  const totalExchanges = convergence.exchanges;
  if (totalExchanges < 4) return [];

  const decisionIndices = new Set(
    (convergence.decisionEvents ?? []).map(e => e.atExchange)
  );

  const episodes: ThrashingEpisode[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < totalExchanges; i++) {
    if (decisionIndices.has(i)) {
      // End any open run
      if (runStart !== null) {
        const runLen = i - runStart;
        if (runLen >= 4) {
          episodes.push(makeEpisode(runStart, i - 1, runLen, totalExchanges, tokenUsage.totalTokens));
        }
      }
      runStart = null;
    } else {
      if (runStart === null) runStart = i;
    }
  }

  // Close trailing run
  if (runStart !== null) {
    const runLen = totalExchanges - runStart;
    if (runLen >= 4) {
      episodes.push(makeEpisode(runStart, totalExchanges - 1, runLen, totalExchanges, tokenUsage.totalTokens));
    }
  }

  return episodes;
}

function makeEpisode(start: number, end: number, exchanges: number, totalExchanges: number, totalTokens: number): ThrashingEpisode {
  return {
    startExchange: start,
    endExchange: end,
    exchanges,
    estimatedTokens: totalExchanges > 0 ? Math.round((exchanges / totalExchanges) * totalTokens) : 0,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: All time analysis + thrashing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extractors/session-economics.ts src/extractors/session-economics.test.ts
git commit -m "feat: add thrashing detection to session-economics extractor (#55)"
```

---

### Task 4: Add dollar cost model

**Files:**
- Modify: `src/extractors/session-economics.ts`
- Modify: `src/extractors/session-economics.test.ts`

- [ ] **Step 1: Write failing tests for dollar cost**

Append to `session-economics.test.ts`:

```typescript
describe("extractSessionEconomics — dollar cost", () => {
  it("computes cost from model pricing in session JSONL", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z", model: "claude-opus-4-6", input_tokens: 1000, output_tokens: 500 },
      { type: "user", timestamp: "2026-04-08T10:02:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:03:00.000Z", model: "claude-opus-4-6", input_tokens: 2000, output_tokens: 1000 },
    ]);
    const tu = makeTokenUsage({ inputTokens: 3000, outputTokens: 1500, totalTokens: 4500 });
    const result = extractSessionEconomics(session, tu, makeConvergence({ exchanges: 2 }));
    // opus: input=$15/MTok, output=$75/MTok
    // cost = (3000 * 15 / 1_000_000) + (1500 * 75 / 1_000_000) = 0.045 + 0.1125 = 0.1575
    assert.ok(result.costDollars !== null);
    assert.equal(Math.round(result.costDollars! * 10000), Math.round(0.1575 * 10000));
  });

  it("returns null cost when no model field in session", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
    ]);
    const result = extractSessionEconomics(session, makeTokenUsage(), makeConvergence({ exchanges: 1 }));
    assert.equal(result.costDollars, null);
  });

  it("handles blended cost with multiple models", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z", model: "claude-opus-4-6", input_tokens: 1000, output_tokens: 500 },
      { type: "user", timestamp: "2026-04-08T10:02:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:03:00.000Z", model: "claude-haiku-4-5", input_tokens: 2000, output_tokens: 1000 },
    ]);
    const tu = makeTokenUsage({ inputTokens: 3000, outputTokens: 1500, totalTokens: 4500 });
    const result = extractSessionEconomics(session, tu, makeConvergence({ exchanges: 2 }));
    // opus: (1000 * 15 + 500 * 75) / 1M = 0.015 + 0.0375 = 0.0525
    // haiku: (2000 * 0.80 + 1000 * 4) / 1M = 0.0016 + 0.004 = 0.0056
    // total: 0.0581
    assert.ok(result.costDollars !== null);
    assert.ok(result.costDollars! > 0.05 && result.costDollars! < 0.07);
  });

  it("uses prefix matching for model versions", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z", model: "claude-sonnet-4-6", input_tokens: 1000, output_tokens: 500 },
    ]);
    const tu = makeTokenUsage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
    const result = extractSessionEconomics(session, tu, makeConvergence({ exchanges: 1 }));
    // sonnet: (1000 * 3 + 500 * 15) / 1M = 0.003 + 0.0075 = 0.0105
    assert.ok(result.costDollars !== null);
    assert.equal(Math.round(result.costDollars! * 10000), Math.round(0.0105 * 10000));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: FAIL — cost tests fail because `computeCost` returns `null`.

- [ ] **Step 3: Implement computeCost with pricing table and model detection**

Replace the `computeCost` placeholder in `session-economics.ts`:

```typescript
const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4": { inputPerMTok: 0.80, outputPerMTok: 4 },
};

function computeCost(sessionPath: string, tokenUsage: TokenUsageSignal): number | null {
  if (!tokenUsage.available) return null;

  const perMessageCosts = readPerMessageCosts(sessionPath);
  if (perMessageCosts === null) return null;

  return Math.round(perMessageCosts * 10000) / 10000; // 4 decimal places
}

interface MessageTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function readPerMessageCosts(sessionPath: string): number | null {
  const messages: MessageTokens[] = [];

  try {
    const content = readFileSync(sessionPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.message?.role !== "assistant") continue;
        const model = msg.message?.model;
        if (!model) continue;
        const usage = msg.message?.usage;
        messages.push({
          model,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        });
      } catch {
        // skip
      }
    }
  } catch {
    return null;
  }

  if (messages.length === 0) return null;

  let totalCost = 0;
  for (const msg of messages) {
    const pricing = findPricing(msg.model);
    if (!pricing) continue;
    totalCost += (msg.inputTokens * pricing.inputPerMTok / 1_000_000)
              + (msg.outputTokens * pricing.outputPerMTok / 1_000_000);
  }

  return totalCost;
}

function findPricing(model: string): ModelPricing | null {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(prefix)) return pricing;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extractors/session-economics.ts src/extractors/session-economics.test.ts
git commit -m "feat: add dollar cost model to session-economics extractor (#55)"
```

---

### Task 5: Add tokensPerDecision tests

**Files:**
- Modify: `src/extractors/session-economics.test.ts`

- [ ] **Step 1: Write tests for tokensPerDecision**

Append to `session-economics.test.ts`:

```typescript
describe("extractSessionEconomics — tokensPerDecision", () => {
  it("computes tokens per decision from total tokens and decision count", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
    ]);
    const convergence = makeConvergence({
      exchanges: 5,
      decisionEvents: [
        { atExchange: 0, type: "approved", detail: "yes" },
        { atExchange: 2, type: "delegated", detail: "go" },
      ],
    });
    const result = extractSessionEconomics(session, makeTokenUsage({ totalTokens: 20000 }), convergence);
    assert.equal(result.tokensPerDecision, 10000);
  });

  it("returns Infinity when no decisions detected", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
    ]);
    const convergence = makeConvergence({ exchanges: 3, decisionEvents: undefined });
    const result = extractSessionEconomics(session, makeTokenUsage(), convergence);
    assert.equal(result.tokensPerDecision, Infinity);
  });

  it("returns Infinity when decisionEvents is empty array", () => {
    const session = createSessionFile([
      { type: "user", timestamp: "2026-04-08T10:00:00.000Z" },
      { type: "assistant", timestamp: "2026-04-08T10:01:00.000Z" },
    ]);
    const convergence = makeConvergence({ exchanges: 3, decisionEvents: [] });
    const result = extractSessionEconomics(session, makeTokenUsage(), convergence);
    assert.equal(result.tokensPerDecision, Infinity);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx tsc && node --test dist/extractors/session-economics.test.js`
Expected: All tests PASS (tokensPerDecision logic already implemented in Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/extractors/session-economics.test.ts
git commit -m "test: add tokensPerDecision tests for session-economics (#55)"
```

---

### Task 6: Add computeSessionROI and wire into runPulse

**Files:**
- Modify: `src/commands/pulse.ts`

- [ ] **Step 1: Add import for session-economics extractor**

Add to the imports at the top of `src/commands/pulse.ts`:

```typescript
import { extractSessionEconomics } from "../extractors/session-economics.js";
```

- [ ] **Step 2: Add computeSessionROI function**

Add after the existing `computeLeverage` function in `pulse.ts`:

```typescript
export function computeSessionROI(
  convergence: PulseReport["convergence"],
  economics: PulseReport["sessionEconomics"],
  decisionQuality: PulseReport["decisionQuality"]
): { score: number; label: "PRODUCTIVE" | "NEUTRAL" | "EXPENSIVE" } {
  const decisions = convergence.decisionEvents?.length ?? 0;
  const { exchanges, outcomes, rate, reworkPercent } = convergence;

  // Yield components
  const decisionDensity = Math.min(decisions / Math.max(exchanges, 1), 1);
  const outcomeDensity = Math.min(outcomes / Math.max(exchanges, 1), 1);
  const convergenceEfficiency = 1 / (1 + rate);
  const yield_ = decisionDensity * 0.4 + outcomeDensity * 0.3 + convergenceEfficiency * 0.3;

  // Cost components
  const tokenBurn = economics.tokensPerDecision === Infinity
    ? 1
    : Math.min(economics.tokensPerDecision / 50000, 1);
  const timeCost = economics.durationMs > 0
    ? Math.min(economics.idleMs / economics.durationMs, 1)
    : 0;
  const instability = reworkPercent / 100 + Math.min(economics.thrashingEpisodes.length * 0.15, 0.45);
  const cost = tokenBurn * 0.4 + timeCost * 0.3 + instability * 0.3;

  const raw = yield_ / Math.max(cost, 0.1);
  const score = Math.round(raw * 100) / 100;

  const label: "PRODUCTIVE" | "NEUTRAL" | "EXPENSIVE" =
    score >= 1.5 ? "PRODUCTIVE" : score >= 0.8 ? "NEUTRAL" : "EXPENSIVE";

  return { score, label };
}
```

- [ ] **Step 3: Wire extractSessionEconomics and computeSessionROI into runPulse**

Update the `runPulse` function. After the `computeLeverage` call, add:

```typescript
  const sessionEconomics = extractSessionEconomics(sessionFile, tokenUsage, convergence);
  const { score: sessionROI, label: sessionROILabel } = computeSessionROI(convergence, sessionEconomics, decisionQuality);
```

And add the new fields to the return object:

```typescript
  return {
    // ... existing fields ...
    leverageScore,
    sessionEconomics,
    sessionROI,
    sessionROILabel,
  };
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Errors only in `aggregateReports` (it doesn't return the new fields yet — fixed in Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/commands/pulse.ts
git commit -m "feat: add computeSessionROI and wire session economics into runPulse (#55)"
```

---

### Task 7: Add SESSION ECONOMICS report section and update summary

**Files:**
- Modify: `src/commands/pulse.ts`

- [ ] **Step 1: Add formatDuration helper**

Add near the existing `rateLabel` helper:

```typescript
function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${totalMinutes}m`;
}
```

- [ ] **Step 2: Add SESSION ECONOMICS section to formatReport**

In `formatReport`, after the TOKEN CORRELATION section (after the closing `}`), add:

```typescript
  // Session Economics
  const se = report.sessionEconomics;
  if (se.durationMs > 0 || se.costDollars !== null) {
    lines.push("SESSION ECONOMICS");
    if (se.durationMs > 0) {
      const dur = formatDuration(se.durationMs);
      const active = formatDuration(se.activeMs);
      const idle = se.idleGaps > 0 ? `, ${formatDuration(se.idleMs)} idle` : "";
      lines.push(`  Duration:              ${dur} (${active} active${idle})`);
    }
    const decisionCount = report.convergence.decisionEvents?.length ?? 0;
    if (decisionCount > 0) {
      const tpd = se.tokensPerDecision === Infinity ? "n/a" : `${(se.tokensPerDecision / 1000).toFixed(1)}k tokens/decision`;
      lines.push(`  Decisions:             ${decisionCount} detected (${tpd})`);
    }
    if (se.thrashingEpisodes.length > 0) {
      const ep = se.thrashingEpisodes.length;
      const totalThrashTokens = `~${(se.thrashingTokens / 1000).toFixed(0)}k tokens`;
      lines.push(`  Thrashing:             ${ep} episode${ep > 1 ? "s" : ""} (${totalThrashTokens})`);
    }
    if (se.costDollars !== null) {
      lines.push(`  Cost:                  $${se.costDollars.toFixed(2)} (estimated)`);
    }
    lines.push(`  Session ROI:           ${report.sessionROI.toFixed(2)} (${report.sessionROILabel})`);
    lines.push("");
  }
```

- [ ] **Step 3: Update the summary section to include Session ROI**

Replace the existing summary lines:

```typescript
  // Summary
  lines.push(hr);
  lines.push(`Interaction Leverage:    ${report.leverageScore.toFixed(2)} (${report.interactionLeverage})`);
  lines.push(hr);
```

With:

```typescript
  // Summary
  lines.push(hr);
  lines.push(`Interaction Leverage:    ${report.leverageScore.toFixed(2)} (${report.interactionLeverage})`);
  if (report.sessionEconomics.durationMs > 0 || report.sessionEconomics.costDollars !== null) {
    lines.push(`Session ROI:             ${report.sessionROI.toFixed(2)} (${report.sessionROILabel})`);
  }
  lines.push(hr);
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Only errors from `aggregateReports` not returning new fields.

- [ ] **Step 5: Commit**

```bash
git add src/commands/pulse.ts
git commit -m "feat: add SESSION ECONOMICS report section and ROI summary (#55)"
```

---

### Task 8: Update aggregateReports for thread mode

**Files:**
- Modify: `src/commands/pulse.ts`

- [ ] **Step 1: Add session economics aggregation to aggregateReports**

In `aggregateReports`, before the final `return`, add:

```typescript
  // Session economics: sum across agents
  const totalDurationMs = reports.reduce((s, r) => s + r.sessionEconomics.durationMs, 0);
  const totalActiveMs = reports.reduce((s, r) => s + r.sessionEconomics.activeMs, 0);
  const totalIdleMs = reports.reduce((s, r) => s + r.sessionEconomics.idleMs, 0);
  const totalIdleGaps = reports.reduce((s, r) => s + r.sessionEconomics.idleGaps, 0);
  const allThrashingEpisodes = reports.flatMap((r) => r.sessionEconomics.thrashingEpisodes);
  const allCosts = reports.map((r) => r.sessionEconomics.costDollars);
  const anyCostNull = allCosts.some((c) => c === null);
  const totalCostDollars = anyCostNull ? null : allCosts.reduce((s, c) => s! + c!, 0);
  const totalDecisions = reports.reduce((s, r) => s + (r.convergence.decisionEvents?.length ?? 0), 0);
  const aggTokPerDecision = totalDecisions > 0 ? Math.round(totalTokens / totalDecisions) : Infinity;
  const aggThrashingTokens = allThrashingEpisodes.reduce((s, e) => s + e.estimatedTokens, 0);

  const sessionEconomics = {
    durationMs: totalDurationMs,
    activeMs: totalActiveMs,
    idleMs: totalIdleMs,
    idleGaps: totalIdleGaps,
    thrashingEpisodes: allThrashingEpisodes,
    costDollars: totalCostDollars,
    tokensPerDecision: aggTokPerDecision,
    thrashingTokens: aggThrashingTokens,
  };

  const { score: sessionROI, label: sessionROILabel } = computeSessionROI(convergence, sessionEconomics, decisionQuality);
```

And add to the return object:

```typescript
  return {
    // ... existing fields ...
    leverageScore,
    sessionEconomics,
    sessionROI,
    sessionROILabel,
  };
```

- [ ] **Step 2: Verify full project compiles**

Run: `npx tsc`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests pass (same pre-existing failures as before, no new failures).

- [ ] **Step 4: Commit**

```bash
git add src/commands/pulse.ts
git commit -m "feat: aggregate session economics in thread mode (#55)"
```

---

### Task 9: Add ROI scoring tests

**Files:**
- Modify: `src/commands/pulse.test.ts`

- [ ] **Step 1: Check current pulse.test.ts structure**

Read: `src/commands/pulse.test.ts` to understand existing test patterns.

- [ ] **Step 2: Add computeSessionROI tests**

Append a new `describe` block to `src/commands/pulse.test.ts`:

Add `computeSessionROI` to the existing import from `./pulse.js` (line 6):

```typescript
import { loadHistoricalScores, formatDelta, runPulse, computeLeverage, computeSessionROI } from "./pulse.js";
```

Then append a new `describe` block at the end of the file:

```typescript
describe("computeSessionROI", () => {
  function makeConvergence(overrides?: Partial<ConvergenceSignal>): ConvergenceSignal {
    return {
      exchanges: 5, outcomes: 3, rate: 1.67,
      reworkInstances: 0, reworkPercent: 0,
      duplicateCommits: 0, blindRetries: 0, pivot: null,
      ...overrides,
    };
  }

  function makeEconomics(overrides?: Partial<SessionEconomicsSignal>): SessionEconomicsSignal {
    return {
      durationMs: 600000, activeMs: 540000, idleMs: 60000, idleGaps: 1,
      thrashingEpisodes: [], costDollars: null,
      tokensPerDecision: 10000, thrashingTokens: 0,
      ...overrides,
    };
  }

  function makeDQ(overrides?: Partial<DecisionQualitySignal>): DecisionQualitySignal {
    return {
      commitsTotal: 3, commitsWithWhy: 2, commitsWithIssueRef: 1,
      externalContextProvided: false, commitMessages: [],
      ...overrides,
    };
  }

  it("returns PRODUCTIVE for high-yield, low-cost session", () => {
    const convergence = makeConvergence({
      exchanges: 5, outcomes: 5, rate: 1,
      decisionEvents: [
        { atExchange: 0, type: "approved", detail: "yes" },
        { atExchange: 1, type: "delegated", detail: "go" },
        { atExchange: 2, type: "approved", detail: "lgtm" },
      ],
    });
    const economics = makeEconomics({ tokensPerDecision: 5000, idleMs: 0, durationMs: 600000 });
    const { score, label } = computeSessionROI(convergence, economics, makeDQ());
    assert.ok(score >= 1.5);
    assert.equal(label, "PRODUCTIVE");
  });

  it("returns EXPENSIVE for no-decision, high-idle session", () => {
    const convergence = makeConvergence({ exchanges: 10, outcomes: 1, rate: 10, decisionEvents: undefined });
    const economics = makeEconomics({
      tokensPerDecision: Infinity, idleMs: 500000, durationMs: 600000,
      thrashingEpisodes: [{ startExchange: 0, endExchange: 9, exchanges: 10, estimatedTokens: 50000 }],
    });
    const { score, label } = computeSessionROI(convergence, economics, makeDQ());
    assert.ok(score < 0.8);
    assert.equal(label, "EXPENSIVE");
  });

  it("returns NEUTRAL for average session", () => {
    const convergence = makeConvergence({
      exchanges: 5, outcomes: 3, rate: 1.67,
      decisionEvents: [{ atExchange: 2, type: "approved", detail: "ok" }],
    });
    const economics = makeEconomics({ tokensPerDecision: 20000, idleMs: 100000, durationMs: 600000 });
    const { score, label } = computeSessionROI(convergence, economics, makeDQ());
    assert.ok(score >= 0.8 && score < 1.5);
    assert.equal(label, "NEUTRAL");
  });

  it("handles zero exchanges gracefully", () => {
    const convergence = makeConvergence({ exchanges: 0, outcomes: 0, rate: 0 });
    const economics = makeEconomics({ durationMs: 0, idleMs: 0, tokensPerDecision: Infinity });
    const { score, label } = computeSessionROI(convergence, economics, makeDQ());
    assert.ok(typeof score === "number");
    assert.ok(!isNaN(score));
    assert.ok(["PRODUCTIVE", "NEUTRAL", "EXPENSIVE"].includes(label));
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx tsc && node --test dist/commands/pulse.test.js`
Expected: All ROI tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/commands/pulse.test.ts
git commit -m "test: add computeSessionROI tests (#55)"
```

---

### Task 10: Dogfood validation on real sessions

**Files:** None modified — validation only.

- [ ] **Step 1: Build and run pulse on Session 1**

Run:
```bash
npm run build && node dist/cli.js run /home/yamakei/Documents/ayumi/.worktrees/1490459966765793411 \
  --session ~/.claude/projects/-home-yamakei-Documents-ayumi--worktrees-1490459966765793411/5d84c481-09d2-45c3-ab48-4b5a6344cc74.jsonl \
  --no-llm --no-save
```

Expected: Report includes new SESSION ECONOMICS section with Duration, Decisions, Session ROI.

- [ ] **Step 2: Run pulse on Session 2**

Run:
```bash
node dist/cli.js run /home/yamakei/Documents/ayumi/.worktrees/1490810904764223754 \
  --session ~/.claude/projects/-home-yamakei-Documents-ayumi--worktrees-1490810904764223754/155c399b-230e-4d37-8430-fb74f6ed6eb6.jsonl \
  --no-llm --no-save
```

- [ ] **Step 3: Run pulse on Session 3**

Run:
```bash
node dist/cli.js run /home/yamakei/Documents/ayumi/.worktrees/1490459966765793411 \
  --session ~/.claude/projects/-home-yamakei-Documents-ayumi--worktrees-1490459966765793411/07424cae-8156-4edb-b86b-6ab7b0a29b9d.jsonl \
  --no-llm --no-save
```

- [ ] **Step 4: Post findings to issue #55**

Post a comment to issue #55 with the SESSION ECONOMICS output from all 3 sessions, noting:
- Whether duration/active/idle split looks reasonable
- Whether thrashing detection fires appropriately
- Whether dollar cost appears (if model field present)
- Whether ROI labels match intuition

- [ ] **Step 5: Commit any fixes if needed, then final commit**

```bash
git add -A
git commit -m "feat: session economics Phase 2 complete (#55)"
```
