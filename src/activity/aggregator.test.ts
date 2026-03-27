import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { aggregateSessions, aggregateSummary } from "./aggregator.js";
import { SessionEvent } from "../types/pulse.js";

function makeStart(ts: string, proj: string, sid: string, agent?: string): SessionEvent {
  return {
    schema_version: 1,
    timestamp: ts,
    event_type: "session_start",
    session_id: sid,
    project_key: proj,
    project_dir: `/tmp/${proj}`,
    trigger_source: "chan-1",
    ...(agent ? { agent_name: agent } : {}),
  } as SessionEvent;
}

function makeEnd(ts: string, proj: string, sid: string, durationMs: number, msgCount: number): SessionEvent {
  return {
    schema_version: 1,
    timestamp: ts,
    event_type: "session_end",
    session_id: sid,
    project_key: proj,
    project_dir: `/tmp/${proj}`,
    duration_ms: durationMs,
    message_count: msgCount,
  } as SessionEvent;
}

function makeRouted(ts: string, proj: string, sid: string, agent?: string, queueDepth = 0): SessionEvent {
  return {
    schema_version: 1,
    timestamp: ts,
    event_type: "message_routed",
    session_id: sid,
    project_key: proj,
    project_dir: `/tmp/${proj}`,
    queue_depth: queueDepth,
    ...(agent ? { agent_target: agent } : {}),
  } as SessionEvent;
}

describe("aggregateSessions", () => {
  it("wraps events in a stable envelope", () => {
    const events = [makeStart("2026-03-26T10:00:00Z", "proj-a", "s1")];
    const result = aggregateSessions("mpg-sessions", events, { range: "7d" });
    assert.equal(result.source, "mpg-sessions");
    assert.equal(result.events.length, 1);
    assert.equal(result.filters.range, "7d");
  });

  it("returns empty events array for no events", () => {
    const result = aggregateSessions("mpg-sessions", [], {});
    assert.deepEqual(result.events, []);
  });
});

describe("aggregateSummary", () => {
  const events: SessionEvent[] = [
    makeStart("2026-03-25T08:00:00Z", "proj-a", "s1", "coder"),
    makeEnd("2026-03-25T09:00:00Z", "proj-a", "s1", 3600000, 10),
    makeStart("2026-03-25T10:00:00Z", "proj-a", "s2"),
    makeEnd("2026-03-25T10:30:00Z", "proj-a", "s2", 1800000, 5),
    makeRouted("2026-03-25T08:05:00Z", "proj-a", "s1", "coder", 2),
    makeRouted("2026-03-25T08:10:00Z", "proj-a", "s1", "reviewer", 1),
    makeStart("2026-03-26T14:00:00Z", "proj-b", "s3"),
    makeEnd("2026-03-26T14:45:00Z", "proj-b", "s3", 2700000, 8),
  ];

  it("counts sessions per bucket (day)", () => {
    const result = aggregateSummary("mpg-sessions", events, "day", {});
    const buckets = result.sessions_per_bucket;
    const projA_mar25 = buckets.find(b => b.project_key === "proj-a" && b.bucket === "2026-03-25");
    assert.equal(projA_mar25?.count, 2);
    const projB_mar26 = buckets.find(b => b.project_key === "proj-b" && b.bucket === "2026-03-26");
    assert.equal(projB_mar26?.count, 1);
  });

  it("computes duration stats from session_end events", () => {
    const result = aggregateSummary("mpg-sessions", events, "day", {});
    const projA = result.duration_stats.find(d => d.project_key === "proj-a");
    assert.ok(projA);
    // proj-a has durations: 3600000, 1800000 → avg=2700000, median=2700000
    assert.equal(projA.avg_ms, 2700000);
    assert.equal(projA.median_ms, 2700000);
  });

  it("counts message volume from message_routed events", () => {
    const result = aggregateSummary("mpg-sessions", events, "day", {});
    const vol = result.message_volume.find(v => v.project_key === "proj-a" && v.bucket === "2026-03-25");
    assert.equal(vol?.count, 2);
  });

  it("breaks down persona usage from session_start agent_name", () => {
    const result = aggregateSummary("mpg-sessions", events, "day", {});
    const coder = result.persona_breakdown.find(p => p.agent === "coder" && p.project_key === "proj-a");
    assert.equal(coder?.count, 1);
    const unknown = result.persona_breakdown.find(p => p.agent === "(none)" && p.project_key === "proj-a");
    assert.equal(unknown?.count, 1);
  });

  it("computes peak concurrency using sweep algorithm", () => {
    // Overlapping test:
    const overlapping: SessionEvent[] = [
      makeStart("2026-03-25T08:00:00Z", "proj-a", "s1"),
      makeStart("2026-03-25T08:30:00Z", "proj-a", "s2"),
      makeEnd("2026-03-25T09:00:00Z", "proj-a", "s1", 3600000, 10),
      makeStart("2026-03-25T08:45:00Z", "proj-a", "s3"),
      makeEnd("2026-03-25T09:30:00Z", "proj-a", "s2", 3600000, 5),
      makeEnd("2026-03-25T10:00:00Z", "proj-a", "s3", 4500000, 12),
    ];
    const result = aggregateSummary("mpg-sessions", overlapping, "day", {});
    const peak = result.peak_concurrent.find(p => p.bucket === "2026-03-25");
    // s1 starts 08:00, s2 starts 08:30, s3 starts 08:45, s1 ends 09:00 → peak 3
    assert.equal(peak?.max_concurrent, 3);
  });

  it("handles unpaired session_start (no matching end) as still-active", () => {
    const unpaired: SessionEvent[] = [
      makeStart("2026-03-25T08:00:00Z", "proj-a", "s1"),
      makeStart("2026-03-25T08:30:00Z", "proj-a", "s2"),
      makeEnd("2026-03-25T09:00:00Z", "proj-a", "s1", 3600000, 10),
      // s2 has no end — still active
    ];
    const result = aggregateSummary("mpg-sessions", unpaired, "day", {});
    const peak = result.peak_concurrent.find(p => p.bucket === "2026-03-25");
    assert.equal(peak?.max_concurrent, 2);
  });

  it("returns empty arrays for no events", () => {
    const result = aggregateSummary("mpg-sessions", [], "day", {});
    assert.deepEqual(result.sessions_per_bucket, []);
    assert.deepEqual(result.duration_stats, []);
    assert.deepEqual(result.message_volume, []);
    assert.deepEqual(result.persona_breakdown, []);
    assert.deepEqual(result.peak_concurrent, []);
  });

  it("uses hour bucketing", () => {
    const result = aggregateSummary("mpg-sessions", events, "hour", {});
    const bucket = result.sessions_per_bucket.find(b => b.project_key === "proj-a" && b.bucket === "2026-03-25T08");
    assert.equal(bucket?.count, 1);
    const bucket2 = result.sessions_per_bucket.find(b => b.project_key === "proj-a" && b.bucket === "2026-03-25T10");
    assert.equal(bucket2?.count, 1);
  });

  it("uses week bucketing", () => {
    const result = aggregateSummary("mpg-sessions", events, "week", {});
    // 2026-03-25 and 2026-03-26 are in the same week (week starting 2026-03-23, Monday)
    assert.ok(result.sessions_per_bucket.length > 0);
    const total = result.sessions_per_bucket.reduce((sum, b) => sum + b.count, 0);
    assert.equal(total, 3); // 3 session_start events total
  });
});
