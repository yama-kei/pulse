# Bucketed Time-Series Fields for Activity Summary

**Issue:** #17
**Date:** 2026-03-27
**Status:** Approved

## Problem

The MPG dashboard expects bucketed time-series arrays from `pulse activity summary --json`, but the CLI returns only flat aggregate fields. The dashboard JS crashes on `d.sessions_per_bucket.forEach(...)` because the field doesn't exist.

## Approach

Extend `aggregateSummary()` in the aggregator to compute 5 new bucketed/grouped fields alongside the existing flat fields. The `--bucket` flag (default `"hour"`) controls time-series granularity. Approach A from brainstorming — all logic stays in the aggregator, no new files.

## Types (`src/types/pulse.ts`)

Add to `ActivitySummary`:

```typescript
sessions_per_bucket: TimeBucket[];
message_volume: TimeBucket[];
persona_breakdown: PersonaCount[];
peak_concurrent_series: PeakBucket[];
duration_stats: DurationStat[];
```

New interfaces:

```typescript
interface TimeBucket {
  bucket: string;   // e.g. "2026-03-26T14" (hour) or "2026-03-26" (day)
  count: number;
}

interface PersonaCount {
  agent: string;    // persona name from message_routed events, or "unknown"
  count: number;
}

interface PeakBucket {
  bucket: string;
  max_concurrent: number;
}

interface DurationStat {
  project_key: string;
  avg_ms: number;
  median_ms: number;
  p95_ms: number;    // same as median when only 1 session
}
```

The existing flat fields (`total_sessions`, `total_messages`, `avg_duration_ms`, `median_duration_ms`, `projects`, `peak_concurrent`) remain unchanged.

Note: The issue names the peak concurrent array field `peak_concurrent`, but that clashes with the existing scalar. We use `peak_concurrent_series` instead. The MPG dashboard will need to reference this name.

## Aggregator (`src/activity/aggregator.ts`)

### Signature change

`aggregateSummary()` gains a `bucketSize` parameter:

```typescript
export function aggregateSummary(
  events: MpgSessionEvent[],
  source: string,
  rangeStart: Date,
  rangeEnd: Date,
  bucketSize?: "hour" | "day"   // default: "hour"
): ActivitySummary
```

### Shared helper

Extract a `bucketKey(timestamp, bucketSize)` function that returns the truncated timestamp string. Replace the inline `.slice()` in `bucketSessions()` with this helper.

```typescript
function bucketKey(timestamp: string, size: "hour" | "day"): string {
  return size === "hour" ? timestamp.slice(0, 13) : timestamp.slice(0, 10);
}
```

### New field computations

All computed inside `aggregateSummary()` after the existing logic:

1. **`sessions_per_bucket`** — filter `session_start` events, group by `bucketKey()`, count per bucket. Sorted by bucket ascending.

2. **`message_volume`** — filter `message_routed` events, group by `bucketKey()`, count per bucket. Sorted by bucket ascending.

3. **`persona_breakdown`** — filter `message_routed` events, group by `e.persona ?? "unknown"`, count per group. Sorted by count descending.

4. **`peak_concurrent_series`** — for each time bucket present in the events, collect all events whose timestamp falls within that bucket, then run the existing `computePeakConcurrent()` delta logic on that subset. Sorted by bucket ascending.

5. **`duration_stats`** — group already-aggregated sessions by `project_key`. For each project, compute `avg_ms` (mean), `median_ms` (reuse existing `median()`), and `p95_ms` (new `percentile95()` helper). Only includes projects that have at least one session with non-null `duration_ms`. Projects with zero completed sessions are omitted.

### New helper

```typescript
function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[idx];
}
```

## CLI (`src/commands/activity.ts`)

### `handleSummary()` changes

- Accept `bucket` parameter from parsed flags (default `"hour"`).
- Validate bucket value (`"hour"` or `"day"`, same as sessions).
- Pass `bucketSize` to `aggregateSummary()`.

### `--bucket` flag scope

Update help text: `--bucket` is valid for both `sessions` and `summary` (remove "sessions only" note).

### `formatSummary()` — no changes

The new fields only appear in `--json` output. The human-readable table format stays as-is.

## Testing

Add tests in `src/activity/aggregator.test.ts`:

- `sessions_per_bucket` groups session_start events by hour and day
- `message_volume` groups message_routed events by hour
- `persona_breakdown` groups by persona, falls back to "unknown"
- `peak_concurrent_series` computes per-bucket peak correctly
- `duration_stats` computes avg/median/p95 per project
- Empty events produce empty arrays (not null/undefined)
- `bucketSize` parameter defaults to "hour" (backward compatible)

Add/update tests in `src/commands/activity.test.ts` (if exists):

- `--bucket` flag works for `summary` subcommand
- JSON output includes all 5 new fields

## Backward Compatibility

- `aggregateSummary()` default `bucketSize` is `"hour"` — existing callers without the parameter still work
- Existing flat fields unchanged — consumers reading those fields are unaffected
- New arrays are always present (empty arrays when no data), never null/undefined
