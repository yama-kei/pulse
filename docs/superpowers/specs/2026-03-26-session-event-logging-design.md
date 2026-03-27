# Session Event Logging for MPG Activity Tracking

**Issue:** [#10](https://github.com/yama-kei/pulse/issues/10)
**Related:** [multi-project-gateway#64](https://github.com/yama-kei/multi-project-gateway/issues/64)
**Date:** 2026-03-26

## Overview

Add session event logging to pulse so it can capture and query historical data about Claude Code sessions managed by multi-project-gateway (MPG). This data powers the activity monitor and graphs on the MPG web dashboard.

## Integration Model

- **Write side:** MPG appends JSONL directly to `~/.pulse/events/mpg-sessions.jsonl`. No pulse CLI call, no library import. Pulse defines the schema; MPG follows it.
- **Read side:** Pulse CLI commands (`pulse activity sessions --json`, `pulse activity summary --json`) handle all aggregation.
- **Dashboard integration:** MPG health server shells out to pulse CLI and proxies the JSON to its `/api/activity/*` endpoints.

No runtime coupling between the two projects.

## Event Schema

### Common Fields (all events)

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | `number` | Always `1`. For forward compatibility. |
| `timestamp` | `string` | ISO 8601 datetime |
| `event_type` | `string` | One of: `session_start`, `session_end`, `session_idle`, `session_resume`, `message_routed` |
| `session_id` | `string` | Claude CLI session ID |
| `project_key` | `string` | Project/channel identifier |
| `project_dir` | `string` | Working directory |

### Per-Type Additional Fields

**`session_start`**
| Field | Type | Description |
|-------|------|-------------|
| `agent_name` | `string?` | Persona name if dispatched via `@mention` |
| `trigger_source` | `string` | Discord channel ID |

**`session_end`**
| Field | Type | Description |
|-------|------|-------------|
| `duration_ms` | `number` | Session duration in milliseconds |
| `message_count` | `number` | Messages during session |

**`session_idle`**
| Field | Type | Description |
|-------|------|-------------|
| `duration_ms` | `number` | Active duration before idle |
| `message_count` | `number` | Messages before idle |

**`session_resume`**
| Field | Type | Description |
|-------|------|-------------|
| `idle_duration_ms` | `number` | How long the session was idle |

**`message_routed`**
| Field | Type | Description |
|-------|------|-------------|
| `agent_target` | `string?` | Target agent/persona if any |
| `queue_depth` | `number` | Queue depth at time of routing |

## File Layout

```
~/.pulse/events/
  mpg-sessions.jsonl    # MPG appends here
  {other-source}.jsonl  # Future sources
```

- One file per source. The `--source` CLI flag maps directly to a filename.
- No registry or config needed.

## Module Architecture

### Reader — `src/activity/reader.ts`

```typescript
readEvents(source: string, options?: {
  since?: Date;
  until?: Date;
  projectKey?: string;
}): SessionEvent[]
```

- Opens `~/.pulse/events/{source}.jsonl`, reads line-by-line
- Parses each line as JSON, validates `schema_version`, filters by time range and project
- Skips malformed lines with a stderr warning (tolerant of partial writes)
- Returns typed `SessionEvent[]` sorted by timestamp
- Missing file/directory returns empty array (no events yet is valid state)

### Aggregator — `src/activity/aggregator.ts`

Takes `SessionEvent[]` and produces two output shapes:

**`ActivitySessions`** — filtered event list in a stable JSON envelope:
```typescript
{ source: string; filters: object; events: SessionEvent[] }
```

**`ActivitySummary`** — aggregated stats:
```typescript
{
  source: string;
  filters: object;
  bucket: "hour" | "day" | "week";
  sessions_per_bucket: { bucket: string; project_key: string; count: number }[];  // counts session_start events
  duration_stats: { project_key: string; avg_ms: number; median_ms: number; p95_ms: number }[];
  message_volume: { bucket: string; project_key: string; count: number }[];
  persona_breakdown: { project_key: string; agent: string; count: number }[];
  peak_concurrent: { bucket: string; max_concurrent: number }[];
}
```

**Aggregation logic:**
- All in-memory. Read events, group, compute.
- Time bucketing: truncate timestamps to bucket boundary, group, count.
- Duration percentiles: sort durations, index at position.
- Peak concurrency: sweep algorithm — +1 at start, -1 at end, track max.

## CLI Commands

New command group: `pulse activity`

### `pulse activity sessions`

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `mpg-sessions` | Event source (maps to filename) |
| `--range` | `7d` | Time range (e.g., `24h`, `7d`, `30d`) |
| `--project` | all | Filter by project key |
| `--type` | all | Filter by event type |
| `--json` | false | Output raw JSON (`ActivitySessions` type) |

Default output: human-readable table of recent events.

### `pulse activity summary`

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `mpg-sessions` | Event source |
| `--range` | `7d` | Time range |
| `--project` | all | Filter by project key |
| `--bucket` | `day` | Time bucket: `hour`, `day`, `week` |
| `--json` | false | Output raw JSON (`ActivitySummary` type) |

Default output: human-readable summary with key stats.

### `pulse activity gc`

| Flag | Default | Description |
|------|---------|-------------|
| `--source` | `mpg-sessions` | Event source |
| `--retention` | `30d` | Retention period |
| `--dry-run` | false | Show what would be removed |

Rewrites JSONL file excluding events older than retention period. Missing file is a no-op.

## Testing

Co-located test files using `node:test`:

- `src/activity/reader.test.ts` — JSONL parsing: valid events, malformed lines, time-range filtering, empty file, missing file
- `src/activity/aggregator.test.ts` — bucketing, duration percentiles, persona breakdown, peak concurrency with known event sets

Tests use fixture JSONL strings written to a temp directory.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Missing events directory/file | Empty result (not an error) |
| Malformed JSONL line | Skip with stderr warning |
| Unknown `schema_version` | Skip with warning |
| Unknown `event_type` | Include in raw list, exclude from typed aggregations |
| `gc` on missing file | No-op |

No file locking needed — MPG appends atomically (single lines < PIPE_BUF), pulse reads. Partial last line handled by malformed-line skipping.

## Non-Goals

- No SQLite or external dependencies — zero-dep, pure JSONL
- No real-time streaming or watch mode
- No cost/token tracking
- No file locking or rotation
