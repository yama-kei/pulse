# Decision Event Detection — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `decision-events` extractor that auto-detects decision events from Claude Code session JSONL, producing a `DecisionEventsSignal` with event list and `tokensPerDecision` headline metric.

**Architecture:** A new extractor (`src/extractors/decision-events.ts`) parses tool-use sequences from session JSONL, builds a file-touch timeline, and pattern-matches to detect decision events. The signal integrates into `PulseReport`, `runPulse()`, and `formatReport()` like existing extractors. Token data from the existing `TokenUsageSignal` feeds `tokensPerDecision`.

**Tech Stack:** TypeScript (strict mode, ES2022, CommonJS), Node.js built-in test runner (`node:test` + `node:assert`).

---

### Task 1: Add Types to `src/types/pulse.ts`

**Files:**
- Modify: `src/types/pulse.ts`

- [ ] **Step 1: Add DecisionEvent and DecisionEventsSignal types**

Add the following types at the end of `src/types/pulse.ts`, before the activity event types section comment:

```typescript
// ── Decision event types (issue #52, Phase 1) ───────────────

export type DecisionEventType =
  | 'implementation_decided'
  | 'root_cause_identified'
  | 'schema_locked'
  | 'contract_finalized'
  | 'feature_shipped'
  | 'bug_resolved'
  | 'design_chosen';

export interface DecisionEvent {
  type: DecisionEventType;
  timestamp: string;
  confidence: 'high' | 'medium' | 'low';
  relatedFiles: string[];
  tokensCost: number;
}

export interface DecisionEventsSignal {
  events: DecisionEvent[];
  decisionCount: number;
  tokensPerDecision: number;
  available: boolean;
}
```

- [ ] **Step 2: Add `decisionEvents` field to `PulseReport`**

Add `decisionEvents: DecisionEventsSignal;` to the `PulseReport` interface, after the `tokenUsage` field:

```typescript
export interface PulseReport {
  timestamp: string;
  project: string;
  cwd: string;
  convergence: ConvergenceSignal;
  intentAnchoring: IntentAnchoringSignal;
  decisionQuality: DecisionQualitySignal;
  tokenUsage: TokenUsageSignal;
  decisionEvents: DecisionEventsSignal;
  interactionPattern: InteractionPatternSignal;
  promptEffectiveness: PromptEffectivenessSignal;
  interactionLeverage: "HIGH" | "MEDIUM" | "LOW";
  leverageScore: number;
}
```

- [ ] **Step 3: Verify the project compiles**

Run: `npm run build`
Expected: Compilation errors in `commands/pulse.ts` (missing `decisionEvents` in report construction). This is expected — we fix it in Task 4.

- [ ] **Step 4: Commit**

```bash
git add src/types/pulse.ts
git commit -m "feat(types): add DecisionEvent and DecisionEventsSignal types (#52)"
```

---

### Task 2: Create the Decision Events Extractor

**Files:**
- Create: `src/extractors/decision-events.ts`

The extractor parses session JSONL to build a timeline of file interactions (reads, edits, commits) and then applies pattern-matching rules to detect decision events.

- [ ] **Step 1: Create `src/extractors/decision-events.ts` with timeline parsing**

```typescript
import { DecisionEvent, DecisionEventType, DecisionEventsSignal } from "../types/pulse.js";
import { readFileSync } from "node:fs";

/** A single file interaction extracted from tool-use blocks */
interface FileTouch {
  action: "read" | "grep" | "edit" | "write" | "commit" | "pr" | "issue";
  file: string;
  timestamp: string;
  /** Cumulative tokens at this point in the session */
  cumulativeTokens: number;
  /** Commit message text (only for action=commit) */
  commitMessage?: string;
}

/**
 * Extract decision events from a Claude Code session JSONL file.
 *
 * Builds a timeline of file touches from tool-use blocks, then applies
 * heuristic patterns to detect moments where uncertainty was resolved.
 */
export function extractDecisionEvents(
  sessionPath: string | null,
  totalTokens: number
): DecisionEventsSignal {
  const empty: DecisionEventsSignal = {
    events: [],
    decisionCount: 0,
    tokensPerDecision: 0,
    available: false,
  };

  if (!sessionPath) return empty;

  let timeline: FileTouch[];
  try {
    timeline = buildTimeline(sessionPath);
  } catch {
    return empty;
  }

  if (timeline.length === 0) return empty;

  const events = detectEvents(timeline);

  // Assign tokensCost: tokens consumed since previous decision event
  assignTokenCosts(events, totalTokens);

  const decisionCount = events.length;
  const tokensPerDecision = decisionCount > 0 ? Math.round(totalTokens / decisionCount) : 0;

  return {
    events,
    decisionCount,
    tokensPerDecision,
    available: true,
  };
}

/** Parse session JSONL into a chronological timeline of file touches */
function buildTimeline(sessionPath: string): FileTouch[] {
  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const timeline: FileTouch[] = [];
  let cumulativeTokens = 0;

  for (const line of lines) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = msg.timestamp || "";

    // Accumulate tokens from assistant messages
    if (msg.message?.role === "assistant" && msg.message?.usage) {
      cumulativeTokens += (msg.message.usage.input_tokens ?? 0) + (msg.message.usage.output_tokens ?? 0);
    }

    // Extract tool-use blocks from assistant messages
    if (msg.type !== "assistant") continue;
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block?.type !== "tool_use") continue;

      const name: string = block.name || "";
      const input: Record<string, unknown> = block.input || {};

      if (name === "Read") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "read", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Grep") {
        const path = typeof input.path === "string" ? input.path : "";
        timeline.push({ action: "grep", file: path || "(cwd)", timestamp, cumulativeTokens });
      } else if (name === "Edit") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "edit", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Write") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "write", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Bash") {
        const cmd = typeof input.command === "string" ? input.command : "";
        if (/\bgit\s+commit\b/.test(cmd)) {
          const msgMatch = cmd.match(/-m\s+(?:"([^"]*?)"|'([^']*?)')/);
          const commitMsg = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? "") : "";
          timeline.push({ action: "commit", file: "", timestamp, cumulativeTokens, commitMessage: commitMsg });
        }
        if (/\bgh\s+pr\s+create\b/.test(cmd)) {
          timeline.push({ action: "pr", file: "", timestamp, cumulativeTokens });
        }
        if (/\bgh\s+issue\s+create\b/.test(cmd)) {
          timeline.push({ action: "issue", file: "", timestamp, cumulativeTokens });
        }
      }
    }
  }

  return timeline;
}

/** Apply heuristic rules over the timeline to detect decision events */
function detectEvents(timeline: FileTouch[]): DecisionEvent[] {
  const events: DecisionEvent[] = [];
  const commitIndices: number[] = [];

  // Index commits for quick lookup
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].action === "commit") commitIndices.push(i);
  }

  // Rule 1: feature_shipped — feat: commit + PR
  // Rule 2: bug_resolved — fix: commit + issue ref
  // Rule 3: root_cause_identified — exploration → fix: commit
  // Rule 4: implementation_decided — reads/edits → commit (no rework)
  // Rule 5: schema_locked — file edited then untouched for rest of session
  // Rule 6: design_chosen — reads across multiple files → single path committed

  const usedCommits = new Set<number>();

  // Pass 1: Commit-based events (highest confidence first)
  for (const ci of commitIndices) {
    const touch = timeline[ci];
    const msg = touch.commitMessage || "";

    // feature_shipped: feat: commit near a PR
    if (/^feat[:(]/i.test(msg)) {
      const hasPR = timeline.slice(ci, Math.min(ci + 5, timeline.length)).some(t => t.action === "pr");
      if (hasPR) {
        events.push({
          type: "feature_shipped",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
        continue;
      }
    }

    // bug_resolved: fix: commit + issue ref
    if (/^fix[:(]/i.test(msg) && /#\d+/.test(msg)) {
      events.push({
        type: "bug_resolved",
        timestamp: touch.timestamp,
        confidence: "high",
        relatedFiles: collectRelatedFiles(timeline, ci),
        tokensCost: 0,
      });
      usedCommits.add(ci);
      continue;
    }

    // root_cause_identified: exploration phase (reads/greps) → fix: commit
    if (/^fix[:(]/i.test(msg) && !usedCommits.has(ci)) {
      const priorActions = timeline.slice(Math.max(0, ci - 10), ci);
      const reads = priorActions.filter(t => t.action === "read" || t.action === "grep").length;
      if (reads >= 2) {
        events.push({
          type: "root_cause_identified",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
        continue;
      }
    }

    // implementation_decided: edits → commit (generic)
    if (!usedCommits.has(ci)) {
      const priorActions = timeline.slice(Math.max(0, ci - 10), ci);
      const hasEdits = priorActions.some(t => t.action === "edit" || t.action === "write");
      if (hasEdits) {
        events.push({
          type: "implementation_decided",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
      }
    }
  }

  // Pass 2: schema_locked — files edited early, untouched in second half
  const midpoint = Math.floor(timeline.length / 2);
  if (midpoint > 0) {
    const editedFirstHalf = new Set<string>();
    const touchedSecondHalf = new Set<string>();

    for (let i = 0; i < midpoint; i++) {
      const t = timeline[i];
      if (t.action === "edit" || t.action === "write") editedFirstHalf.add(t.file);
    }
    for (let i = midpoint; i < timeline.length; i++) {
      const t = timeline[i];
      if (t.action === "edit" || t.action === "write" || t.action === "read") touchedSecondHalf.add(t.file);
    }

    for (const file of editedFirstHalf) {
      if (!touchedSecondHalf.has(file)) {
        // Find the last edit of this file
        let lastEditIdx = -1;
        for (let i = midpoint - 1; i >= 0; i--) {
          if ((timeline[i].action === "edit" || timeline[i].action === "write") && timeline[i].file === file) {
            lastEditIdx = i;
            break;
          }
        }
        if (lastEditIdx >= 0) {
          events.push({
            type: "schema_locked",
            timestamp: timeline[lastEditIdx].timestamp,
            confidence: "medium",
            relatedFiles: [file],
            tokensCost: 0,
          });
        }
      }
    }
  }

  // Pass 3: design_chosen — many reads across different files → single path committed
  for (const ci of commitIndices) {
    if (usedCommits.has(ci)) continue;
    const window = timeline.slice(Math.max(0, ci - 15), ci);
    const readFiles = new Set(window.filter(t => t.action === "read").map(t => t.file));
    const editFiles = new Set(window.filter(t => t.action === "edit" || t.action === "write").map(t => t.file));
    if (readFiles.size >= 3 && editFiles.size <= 2 && editFiles.size > 0) {
      events.push({
        type: "design_chosen",
        timestamp: timeline[ci].timestamp,
        confidence: "medium",
        relatedFiles: [...editFiles],
        tokensCost: 0,
      });
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return events;
}

/** Collect files that were edited/written in the window before a commit */
function collectRelatedFiles(timeline: FileTouch[], commitIdx: number): string[] {
  const files = new Set<string>();
  for (let i = Math.max(0, commitIdx - 10); i < commitIdx; i++) {
    const t = timeline[i];
    if ((t.action === "edit" || t.action === "write") && t.file) {
      files.add(t.file);
    }
  }
  return [...files];
}

/** Assign tokensCost to each event: tokens consumed since previous event */
function assignTokenCosts(events: DecisionEvent[], totalTokens: number): void {
  if (events.length === 0) return;

  // Simple proportional distribution: totalTokens / eventCount
  // (More precise tracking would require correlating events back to timeline positions,
  // but this is sufficient for the first cut)
  const perEvent = Math.round(totalTokens / events.length);
  for (const event of events) {
    event.tokensCost = perEvent;
  }
}
```

- [ ] **Step 2: Verify the file compiles in isolation**

Run: `npx tsc --noEmit src/extractors/decision-events.ts`
Expected: May show errors if tsconfig isn't picked up. Use full build instead:
Run: `npm run build 2>&1 | head -20`
Expected: Errors only in `commands/pulse.ts` (missing `decisionEvents` property) — the new extractor itself should compile clean.

- [ ] **Step 3: Commit**

```bash
git add src/extractors/decision-events.ts
git commit -m "feat: add decision events extractor with timeline-based heuristics (#52)"
```

---

### Task 3: Write Tests for Decision Events Extractor

**Files:**
- Create: `src/extractors/decision-events.test.ts`

- [ ] **Step 1: Create `src/extractors/decision-events.test.ts`**

```typescript
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractDecisionEvents } from "./decision-events.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTmpSession(lines: string[], fn: (file: string) => void) {
  const tmp = mkdtempSync(join(tmpdir(), "pulse-test-"));
  const file = join(tmp, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  try {
    fn(file);
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

function assistantWithTools(tools: Array<{ name: string; input: Record<string, unknown> }>, timestamp: string, tokens = 1000) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: tools.map(t => ({ type: "tool_use", name: t.name, input: t.input })),
      usage: { input_tokens: tokens, output_tokens: tokens / 2 },
    },
  });
}

function userMessage(text: string, timestamp: string) {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: { role: "user", content: text },
  });
}

describe("extractDecisionEvents", () => {
  it("returns unavailable signal with no session file", () => {
    const result = extractDecisionEvents(null, 0);
    assert.equal(result.available, false);
    assert.equal(result.decisionCount, 0);
    assert.equal(result.tokensPerDecision, 0);
  });

  it("returns unavailable signal for nonexistent file", () => {
    const result = extractDecisionEvents("/tmp/nonexistent.jsonl", 0);
    assert.equal(result.available, false);
  });

  it("detects implementation_decided from edit → commit", () => {
    withTmpSession([
      userMessage("add a login form", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add login form"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      assert.equal(result.available, true);
      assert.equal(result.decisionCount, 1);
      assert.equal(result.events[0].type, "implementation_decided");
      assert.equal(result.events[0].confidence, "high");
      assert.deepEqual(result.events[0].relatedFiles, ["src/auth.ts"]);
    });
  });

  it("detects feature_shipped from feat: commit + PR", () => {
    withTmpSession([
      userMessage("ship the feature", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/feature.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: new feature"' } },
        { name: "Bash", input: { command: 'gh pr create --title "feat" --body "done"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      const shipped = result.events.find(e => e.type === "feature_shipped");
      assert.ok(shipped, "should detect feature_shipped");
      assert.equal(shipped!.confidence, "high");
    });
  });

  it("detects bug_resolved from fix: commit + issue ref", () => {
    withTmpSession([
      userMessage("fix the auth bug", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "fix: resolve auth crash (#42)"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      const resolved = result.events.find(e => e.type === "bug_resolved");
      assert.ok(resolved, "should detect bug_resolved");
      assert.equal(resolved!.confidence, "high");
    });
  });

  it("detects root_cause_identified from exploration → fix: commit", () => {
    withTmpSession([
      userMessage("figure out why auth fails", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Grep", input: { pattern: "error", path: "src/" } },
        { name: "Read", input: { file_path: "src/middleware.ts" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:02:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "fix: correct token validation"' } },
      ], "2026-04-02T10:03:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 6000);
      const rootCause = result.events.find(e => e.type === "root_cause_identified");
      assert.ok(rootCause, "should detect root_cause_identified");
    });
  });

  it("detects schema_locked for files edited early and untouched later", () => {
    withTmpSession([
      userMessage("set up types", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Write", input: { file_path: "src/types.ts" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add types"' } },
      ], "2026-04-02T10:02:00Z"),
      // Second half of session works on different files
      userMessage("now implement the handler", "2026-04-02T10:03:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/handler.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:04:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add handler"' } },
      ], "2026-04-02T10:05:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 6000);
      const locked = result.events.find(e => e.type === "schema_locked");
      assert.ok(locked, "should detect schema_locked for types.ts");
      assert.equal(locked!.confidence, "medium");
      assert.deepEqual(locked!.relatedFiles, ["src/types.ts"]);
    });
  });

  it("computes tokensPerDecision correctly", () => {
    withTmpSession([
      userMessage("do work", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: first"' } },
      ], "2026-04-02T10:02:00Z"),
      userMessage("more work", "2026-04-02T10:03:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/b.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:04:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: second"' } },
      ], "2026-04-02T10:05:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 10000);
      assert.equal(result.decisionCount, 2);
      assert.equal(result.tokensPerDecision, 5000);
    });
  });

  it("returns empty events for session with no tool use", () => {
    withTmpSession([
      userMessage("hello", "2026-04-02T10:00:00Z"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-02T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      }),
    ], (file) => {
      const result = extractDecisionEvents(file, 1000);
      assert.equal(result.available, false);
      assert.equal(result.decisionCount, 0);
    });
  });

  it("handles malformed JSON lines gracefully", () => {
    withTmpSession([
      "not valid json",
      userMessage("do work", "2026-04-02T10:00:00Z"),
      "{truncated",
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: something"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      assert.equal(result.available, true);
      assert.ok(result.decisionCount >= 1, "should detect at least one event despite malformed lines");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (extractor not wired yet, but should compile and run)**

Run: `npm run build && node --test dist/extractors/decision-events.test.js`
Expected: All tests PASS (the extractor file exists and is importable).

- [ ] **Step 3: Commit**

```bash
git add src/extractors/decision-events.test.ts
git commit -m "test: add decision events extractor tests (#52)"
```

---

### Task 4: Integrate into `runPulse()` and `formatReport()`

**Files:**
- Modify: `src/commands/pulse.ts`

- [ ] **Step 1: Add import for the new extractor**

At the top of `src/commands/pulse.ts`, add after the `extractTokenUsage` import:

```typescript
import { extractDecisionEvents } from "../extractors/decision-events.js";
```

- [ ] **Step 2: Call extractDecisionEvents in runPulse()**

In the `runPulse()` function, after the `tokenUsage` extraction line (`const tokenUsage = extractTokenUsage(...)`) and before the `interactionPattern` line, add:

```typescript
  const decisionEvents = extractDecisionEvents(sessionFile, tokenUsage.totalTokens);
```

- [ ] **Step 3: Add `decisionEvents` to the return object**

In the `runPulse()` return statement, add `decisionEvents` after `tokenUsage`:

```typescript
  return {
    timestamp: new Date().toISOString(),
    project,
    cwd: projectDir,
    convergence,
    intentAnchoring,
    decisionQuality,
    tokenUsage,
    decisionEvents,
    interactionPattern,
    promptEffectiveness,
    interactionLeverage,
    leverageScore,
  };
```

- [ ] **Step 4: Add DECISION EVENTS section to formatReport()**

In `formatReport()`, after the "TOKEN CORRELATION" block (after the `lines.push("");` that follows `tokensPerOutcome`) and before the "INTERACTION PATTERN" block, add:

```typescript
  // Decision Events
  const de = report.decisionEvents;
  if (de.available) {
    lines.push("DECISION EVENTS");
    lines.push(`  Decisions detected:    ${de.decisionCount}`);
    if (de.tokensPerDecision > 0) {
      lines.push(`  Tokens per decision:   ${de.tokensPerDecision.toLocaleString()}`);
    }
    if (de.events.length > 0) {
      for (const event of de.events) {
        const files = event.relatedFiles.length > 0 ? ` (${event.relatedFiles.join(", ")})` : "";
        lines.push(`    ${event.type} [${event.confidence}]${files}`);
      }
    }
    lines.push("");
  }
```

- [ ] **Step 5: Add decisionEvents to aggregateReports()**

In the `aggregateReports()` function, after the `tokenUsage` aggregation block and before the prompt effectiveness block, add:

```typescript
  // Decision events: merge all events, recalculate totals
  const allDecisionEvents = reports.flatMap(r => r.decisionEvents?.events ?? []);
  const anyDecisionEventsAvailable = reports.some(r => r.decisionEvents?.available);
  const totalDecisionCount = allDecisionEvents.length;
  const decisionEvents: DecisionEventsSignal = {
    events: allDecisionEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    decisionCount: totalDecisionCount,
    tokensPerDecision: totalDecisionCount > 0 ? Math.round(totalTokens / totalDecisionCount) : 0,
    available: anyDecisionEventsAvailable,
  };
```

And add `decisionEvents` to the return statement in `aggregateReports()`.

- [ ] **Step 6: Add import for DecisionEventsSignal type**

At the top of `src/commands/pulse.ts`, update the type import to include `DecisionEventsSignal`:

```typescript
import { PulseReport, AgentReport, ThreadPulseReport, DecisionEventsSignal } from "../types/pulse.js";
```

- [ ] **Step 7: Verify compilation**

Run: `npm run build`
Expected: Clean compilation, no errors.

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: All tests pass, including the new decision-events tests.

- [ ] **Step 9: Commit**

```bash
git add src/commands/pulse.ts
git commit -m "feat: integrate decision events into pulse run and report (#52)"
```

---

### Task 5: Add Decision Events Nudge

**Files:**
- Modify: `src/commands/pulse.ts` (the `generateNudges` function)

- [ ] **Step 1: Add nudge for low decision count with high token usage**

In the `generateNudges()` function, before the final `return nudges;`, add:

```typescript
  // Decision event nudges
  const de = report.decisionEvents;
  if (de.available && de.decisionCount === 0 && tu.available && tu.totalTokens > 10000) {
    nudges.push("No decision events detected despite significant token usage. Consider breaking work into smaller, committable increments.");
  }
  if (de.available && de.tokensPerDecision > 50000) {
    nudges.push(`${de.tokensPerDecision.toLocaleString()} tokens per decision is high. More frequent commits and smaller scope can improve decision yield.`);
  }
```

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/commands/pulse.ts
git commit -m "feat: add decision event nudges for low yield and high cost (#52)"
```

---

### Task 6: End-to-End Verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Build and verify no type errors**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 3: Manual smoke test with a real session**

Run: `node dist/cli.js`
Expected: The report includes a "DECISION EVENTS" section (or omits it gracefully if no events detected — both are correct).

- [ ] **Step 4: Commit any remaining fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix: address issues found in end-to-end verification (#52)"
```
