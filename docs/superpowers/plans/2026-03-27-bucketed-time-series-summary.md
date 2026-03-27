# Bucketed Time-Series Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5 bucketed time-series array fields to `pulse activity summary --json` output so the MPG dashboard can render session charts.

**Architecture:** Extend the existing `aggregateSummary()` function with a `bucketSize` parameter. All new computations use existing event data and helpers. No new files — changes span types, aggregator, CLI, and their tests.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test` + `node:assert`)

**Spec:** `docs/superpowers/specs/2026-03-27-bucketed-time-series-summary-design.md`

---

### Task 1: Add new type interfaces

**Files:**
- Modify: `src/types/pulse.ts:144-186`

- [ ] **Step 1: Add the 4 new interfaces after `MpgSessionEvent`**

Add these interfaces after line 157 (after the closing `}` of `MpgSessionEvent`):

```typescript
export interface TimeBucket {
  bucket: string;
  count: number;
}

export interface PersonaCount {
  agent: string;
  count: number;
}

export interface PeakBucket {
  bucket: string;
  max_concurrent: number;
}

export interface DurationStat {
  project_key: string;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;
}
```

- [ ] **Step 2: Add 5 new fields to `ActivitySummary`**

Add these fields to the `ActivitySummary` interface, after the `peak_concurrent` field:

```typescript
  sessions_per_bucket: TimeBucket[];
  message_volume: TimeBucket[];
  persona_breakdown: PersonaCount[];
  peak_concurrent_series: PeakBucket[];
  duration_stats: DurationStat[];
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: Compilation errors in `aggregator.ts` and `activity.test.ts` because `aggregateSummary()` no longer returns a complete `ActivitySummary` (missing the new fields). This confirms the types are wired in correctly.

- [ ] **Step 4: Commit**

```bash
git add src/types/pulse.ts
git commit -m "feat(types): add TimeBucket, PersonaCount, PeakBucket, DurationStat interfaces and extend ActivitySummary (#17)"
```

---

### Task 2: Implement bucketed fields in aggregator

**Files:**
- Modify: `src/activity/aggregator.ts`

- [ ] **Step 1: Write failing tests for `sessions_per_bucket` and `message_volume`**

Add to `src/activity/aggregator.test.ts`, inside a new `describe("aggregateSummary bucketed fields")` block after the existing `aggregateSummary` describe:

```typescript
describe("aggregateSummary bucketed fields", () => {
  const events: MpgSessionEvent[] = [
    evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
    evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1", persona: "pm" }),
    evt({ timestamp: "2026-03-27T10:10:00Z", event_type: "message_routed", session_id: "s1", persona: "pm" }),
    evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_800_000 }),
    evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s2", project_key: "other" }),
    evt({ timestamp: "2026-03-27T11:05:00Z", event_type: "message_routed", session_id: "s2", project_key: "other", persona: "engineer" }),
    evt({ timestamp: "2026-03-27T11:30:00Z", event_type: "session_end", session_id: "s2", project_key: "other", duration_ms: 1_800_000 }),
  ];
  const start = new Date("2026-03-27T00:00:00Z");
  const end = new Date("2026-03-28T00:00:00Z");

  it("computes sessions_per_bucket by hour", () => {
    const summary = aggregateSummary(events, "mpg", start, end, "hour");
    assert.deepStrictEqual(summary.sessions_per_bucket, [
      { bucket: "2026-03-27T10", count: 1 },
      { bucket: "2026-03-27T11", count: 1 },
    ]);
  });

  it("computes sessions_per_bucket by day", () => {
    const summary = aggregateSummary(events, "mpg", start, end, "day");
    assert.deepStrictEqual(summary.sessions_per_bucket, [
      { bucket: "2026-03-27", count: 2 },
    ]);
  });

  it("computes message_volume by hour", () => {
    const summary = aggregateSummary(events, "mpg", start, end, "hour");
    assert.deepStrictEqual(summary.message_volume, [
      { bucket: "2026-03-27T10", count: 2 },
      { bucket: "2026-03-27T11", count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc && node --test dist/activity/aggregator.test.js 2>&1 | tail -20`

Expected: Compilation errors because `aggregateSummary` return value is missing the new fields.

- [ ] **Step 3: Add `bucketKey` helper and `percentile95` helper**

Add these private functions at the bottom of `src/activity/aggregator.ts`, before the closing of the file:

```typescript
function bucketKey(timestamp: string, size: "hour" | "day"): string {
  return size === "hour" ? timestamp.slice(0, 13) : timestamp.slice(0, 10);
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[idx];
}
```

- [ ] **Step 4: Refactor `bucketSessions` to use `bucketKey` helper**

In `bucketSessions()`, replace the inline slice logic:

```typescript
// Before:
    const key = bucketSize === "hour"
      ? e.timestamp.slice(0, 13)
      : e.timestamp.slice(0, 10);

// After:
    const key = bucketKey(e.timestamp, bucketSize);
```

- [ ] **Step 5: Update `aggregateSummary` signature and implement all 5 fields**

Change the signature to accept optional `bucketSize`:

```typescript
export function aggregateSummary(
  events: MpgSessionEvent[],
  source: string,
  rangeStart: Date,
  rangeEnd: Date,
  bucketSize: "hour" | "day" = "hour"
): ActivitySummary {
```

After the existing `projects` computation (after the `for (const s of sessions)` loop), add:

```typescript
  // sessions_per_bucket
  const sessionBucketMap = new Map<string, number>();
  for (const e of events) {
    if (e.event_type === "session_start") {
      const key = bucketKey(e.timestamp, bucketSize);
      sessionBucketMap.set(key, (sessionBucketMap.get(key) ?? 0) + 1);
    }
  }
  const sessions_per_bucket = Array.from(sessionBucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, count]) => ({ bucket, count }));

  // message_volume
  const msgBucketMap = new Map<string, number>();
  for (const e of events) {
    if (e.event_type === "message_routed") {
      const key = bucketKey(e.timestamp, bucketSize);
      msgBucketMap.set(key, (msgBucketMap.get(key) ?? 0) + 1);
    }
  }
  const message_volume = Array.from(msgBucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, count]) => ({ bucket, count }));

  // persona_breakdown
  const personaMap = new Map<string, number>();
  for (const e of events) {
    if (e.event_type === "message_routed") {
      const agent = e.persona ?? "unknown";
      personaMap.set(agent, (personaMap.get(agent) ?? 0) + 1);
    }
  }
  const persona_breakdown = Array.from(personaMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([agent, count]) => ({ agent, count }));

  // peak_concurrent_series
  const allBuckets = new Set<string>();
  for (const e of events) {
    allBuckets.add(bucketKey(e.timestamp, bucketSize));
  }
  const peak_concurrent_series = Array.from(allBuckets)
    .sort()
    .map(bucket => {
      const bucketEvents = events.filter(e => bucketKey(e.timestamp, bucketSize) === bucket);
      return { bucket, max_concurrent: computePeakConcurrent(bucketEvents) };
    });

  // duration_stats
  const projectDurations = new Map<string, number[]>();
  for (const s of sessions) {
    if (s.duration_ms !== null) {
      if (!projectDurations.has(s.project_key)) {
        projectDurations.set(s.project_key, []);
      }
      projectDurations.get(s.project_key)!.push(s.duration_ms);
    }
  }
  const duration_stats = Array.from(projectDurations.entries()).map(([project_key, durations]) => ({
    project_key,
    avg_ms: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    median_ms: median(durations)!,
    p95_ms: percentile95(durations),
  }));
```

Then update the return statement to include the new fields:

```typescript
  return {
    source,
    range_start: rangeStart.toISOString(),
    range_end: rangeEnd.toISOString(),
    total_sessions: sessions.length,
    total_messages: totalMessages,
    avg_duration_ms: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    median_duration_ms: median(durations),
    projects,
    peak_concurrent: computePeakConcurrent(events),
    sessions_per_bucket,
    message_volume,
    persona_breakdown,
    peak_concurrent_series,
    duration_stats,
  };
```

- [ ] **Step 6: Run tests to verify the 3 new tests pass**

Run: `npx tsc && node --test dist/activity/aggregator.test.js 2>&1 | tail -20`

Expected: All tests pass, including the 3 new ones.

- [ ] **Step 7: Commit**

```bash
git add src/activity/aggregator.ts src/activity/aggregator.test.ts
git commit -m "feat(aggregator): add bucketed time-series fields to aggregateSummary (#17)"
```

---

### Task 3: Add remaining aggregator tests

**Files:**
- Modify: `src/activity/aggregator.test.ts`

- [ ] **Step 1: Write tests for persona_breakdown, peak_concurrent_series, duration_stats, and empty events**

Add these tests inside the existing `describe("aggregateSummary bucketed fields")` block (after the `message_volume` test):

```typescript
  it("computes persona_breakdown sorted by count descending", () => {
    const summary = aggregateSummary(events, "mpg", start, end);
    assert.deepStrictEqual(summary.persona_breakdown, [
      { agent: "pm", count: 2 },
      { agent: "engineer", count: 1 },
    ]);
  });

  it("persona_breakdown uses 'unknown' when persona is missing", () => {
    const noPersonaEvents: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 600_000 }),
    ];
    const summary = aggregateSummary(noPersonaEvents, "mpg", start, end);
    assert.deepStrictEqual(summary.persona_breakdown, [
      { agent: "unknown", count: 1 },
    ]);
  });

  it("computes peak_concurrent_series per bucket", () => {
    const overlapping: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "session_start", session_id: "s2" }),
      evt({ timestamp: "2026-03-27T10:20:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_200_000 }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s2", duration_ms: 1_500_000 }),
      evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s3" }),
      evt({ timestamp: "2026-03-27T11:30:00Z", event_type: "session_end", session_id: "s3", duration_ms: 1_800_000 }),
    ];
    const summary = aggregateSummary(overlapping, "mpg", start, end, "hour");
    assert.deepStrictEqual(summary.peak_concurrent_series, [
      { bucket: "2026-03-27T10", max_concurrent: 2 },
      { bucket: "2026-03-27T11", max_concurrent: 1 },
    ]);
  });

  it("computes duration_stats per project", () => {
    const summary = aggregateSummary(events, "mpg", start, end);
    assert.equal(summary.duration_stats.length, 2);
    const proj = summary.duration_stats.find(d => d.project_key === "proj")!;
    assert.equal(proj.avg_ms, 1_800_000);
    assert.equal(proj.median_ms, 1_800_000);
    assert.equal(proj.p95_ms, 1_800_000);
    const other = summary.duration_stats.find(d => d.project_key === "other")!;
    assert.equal(other.avg_ms, 1_800_000);
  });

  it("returns empty arrays for no events", () => {
    const summary = aggregateSummary([], "mpg", start, end);
    assert.deepStrictEqual(summary.sessions_per_bucket, []);
    assert.deepStrictEqual(summary.message_volume, []);
    assert.deepStrictEqual(summary.persona_breakdown, []);
    assert.deepStrictEqual(summary.peak_concurrent_series, []);
    assert.deepStrictEqual(summary.duration_stats, []);
  });

  it("defaults bucketSize to hour", () => {
    const summary = aggregateSummary(events, "mpg", start, end);
    assert.deepStrictEqual(summary.sessions_per_bucket, [
      { bucket: "2026-03-27T10", count: 1 },
      { bucket: "2026-03-27T11", count: 1 },
    ]);
  });
```

- [ ] **Step 2: Run all aggregator tests**

Run: `npx tsc && node --test dist/activity/aggregator.test.js 2>&1 | tail -30`

Expected: All tests pass (existing + new).

- [ ] **Step 3: Commit**

```bash
git add src/activity/aggregator.test.ts
git commit -m "test(aggregator): add tests for bucketed fields, persona, peak concurrent, duration stats (#17)"
```

---

### Task 4: Wire `--bucket` flag into summary CLI and update help text

**Files:**
- Modify: `src/commands/activity.ts`

- [ ] **Step 1: Write failing test for `--bucket` on summary**

Add to `src/commands/activity.test.ts`, inside the existing `describe("runActivity")`:

```typescript
  it("summary with --bucket returns bucketed fields", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1", project_key: "proj", project_dir: "/tmp", persona: "pm" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", project_key: "proj", project_dir: "/tmp", duration_ms: 1800000 }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s2", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T11:05:00Z", event_type: "message_routed", session_id: "s2", project_key: "proj", project_dir: "/tmp", persona: "engineer" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T11:30:00Z", event_type: "session_end", session_id: "s2", project_key: "proj", project_dir: "/tmp", duration_ms: 1800000 }),
    ]);
    const result = runActivity(["summary", "--source", "mpg", "--range", "7d", "--bucket", "hour", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.total_sessions, 2);
    assert.ok(Array.isArray(parsed.sessions_per_bucket));
    assert.equal(parsed.sessions_per_bucket.length, 2);
    assert.ok(Array.isArray(parsed.message_volume));
    assert.ok(Array.isArray(parsed.persona_breakdown));
    assert.ok(Array.isArray(parsed.peak_concurrent_series));
    assert.ok(Array.isArray(parsed.duration_stats));
  });

  it("summary rejects invalid --bucket values", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["summary", "--source", "mpg", "--range", "7d", "--bucket", "week"], dir);
    assert.ok(result.startsWith("Error:"));
    assert.ok(result.includes("week"));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsc && node --test dist/commands/activity.test.js 2>&1 | tail -20`

Expected: The `--bucket` test fails because `handleSummary` doesn't accept or pass through the bucket flag.

- [ ] **Step 3: Update `handleSummary` to accept and pass `--bucket`**

In `src/commands/activity.ts`, change `handleSummary` to accept and validate `bucket`:

```typescript
function handleSummary(
  dir: string, source: string, range: string, project: string | undefined,
  bucket: string | undefined, json: boolean
): string {
  if (bucket && bucket !== "hour" && bucket !== "day") {
    return `Error: --bucket must be "hour" or "day", got "${bucket}"`;
  }
  const now = new Date();
  const after = parseRange(range, now);
  const events = readEvents(dir, source, { after, project });
  const bucketSize = (bucket as "hour" | "day" | undefined) ?? "hour";
  const summary = aggregateSummary(events, source, after, now, bucketSize);
  if (json) return JSON.stringify(summary, null, 2);
  return formatSummary(summary);
}
```

- [ ] **Step 4: Update the `switch` statement to pass bucket to `handleSummary`**

In the `runActivity` function, update the `summary` case:

```typescript
    case "summary":
      return handleSummary(dir, source, range, project, flags.bucket as string | undefined, json);
```

- [ ] **Step 5: Update help text**

Change the `--bucket` line in `activityHelp()`:

```typescript
  --bucket <size>     Bucket by: hour, day (sessions, summary)
```

- [ ] **Step 6: Run all tests**

Run: `npx tsc && node --test dist/**/*.test.js 2>&1 | tail -30`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/commands/activity.ts src/commands/activity.test.ts
git commit -m "feat(cli): wire --bucket flag into activity summary command (#17)"
```

---

### Task 5: Update CLAUDE.md and final verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test 2>&1 | tail -30`

Expected: All tests pass, clean compilation.

- [ ] **Step 2: Verify JSON output manually**

Run: `node bin/pulse.js activity summary --json --range 7d 2>&1 | head -40`

Expected: JSON output includes `sessions_per_bucket`, `message_volume`, `persona_breakdown`, `peak_concurrent_series`, and `duration_stats` fields (likely empty arrays if no events exist locally, which is fine).

- [ ] **Step 3: Commit CLAUDE.md if not already updated**

The CLAUDE.md was already updated earlier in this conversation to reflect PR 15 changes. No additional CLAUDE.md changes needed for this issue unless the review identifies gaps.

- [ ] **Step 4: Final commit and verify clean state**

Run: `git status && git log --oneline -5`

Expected: Clean working tree, all commits present.
