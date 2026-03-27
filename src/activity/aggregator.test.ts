import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { aggregateSessions, aggregateSummary, bucketSessions } from "./aggregator.js";
import { MpgSessionEvent } from "../types/pulse.js";

function evt(overrides: Partial<MpgSessionEvent> & Pick<MpgSessionEvent, "timestamp" | "event_type" | "session_id">): MpgSessionEvent {
  return {
    schema_version: 1,
    project_key: "proj",
    project_dir: "/tmp/proj",
    ...overrides,
  };
}

describe("aggregateSessions", () => {
  it("returns empty array for no events", () => {
    assert.deepStrictEqual(aggregateSessions([]), []);
  });

  it("builds a session from start + messages + end", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:10:00Z", event_type: "message_routed", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_800_000 }),
    ];
    const sessions = aggregateSessions(events);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, "s1");
    assert.equal(sessions[0].message_count, 2);
    assert.equal(sessions[0].duration_ms, 1_800_000);
    assert.equal(sessions[0].ended_at, "2026-03-27T10:30:00Z");
  });

  it("handles session without end event (still open)", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1" }),
    ];
    const sessions = aggregateSessions(events);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].ended_at, null);
    assert.equal(sessions[0].duration_ms, null);
  });

  it("tracks idle and resume counts", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:10:00Z", event_type: "session_idle", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:20:00Z", event_type: "session_resume", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_800_000 }),
    ];
    const sessions = aggregateSessions(events);
    assert.equal(sessions[0].idle_count, 1);
    assert.equal(sessions[0].resume_count, 1);
  });

  it("handles multiple sessions", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s2", project_key: "other" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_800_000 }),
      evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_end", session_id: "s2", duration_ms: 3_600_000 }),
    ];
    const sessions = aggregateSessions(events);
    assert.equal(sessions.length, 2);
  });
});

describe("aggregateSummary", () => {
  it("returns zero summary for no events", () => {
    const summary = aggregateSummary([], "mpg", new Date("2026-03-20T00:00:00Z"), new Date("2026-03-27T00:00:00Z"));
    assert.equal(summary.total_sessions, 0);
    assert.equal(summary.total_messages, 0);
    assert.equal(summary.avg_duration_ms, null);
    assert.equal(summary.peak_concurrent, 0);
  });

  it("computes summary from events", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:10:00Z", event_type: "message_routed", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_800_000 }),
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s2", project_key: "other" }),
      evt({ timestamp: "2026-03-27T10:15:00Z", event_type: "message_routed", session_id: "s2", project_key: "other" }),
      evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_end", session_id: "s2", project_key: "other", duration_ms: 3_600_000 }),
    ];
    const summary = aggregateSummary(events, "mpg", new Date("2026-03-27T00:00:00Z"), new Date("2026-03-28T00:00:00Z"));
    assert.equal(summary.total_sessions, 2);
    assert.equal(summary.total_messages, 3);
    assert.equal(summary.avg_duration_ms, 2_700_000);
    assert.equal(summary.peak_concurrent, 2);
    assert.equal(summary.projects["proj"].sessions, 1);
    assert.equal(summary.projects["other"].sessions, 1);
  });

  it("computes median duration", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", duration_ms: 1_000_000 }),
      evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s2" }),
      evt({ timestamp: "2026-03-27T11:30:00Z", event_type: "session_end", session_id: "s2", duration_ms: 2_000_000 }),
      evt({ timestamp: "2026-03-27T12:00:00Z", event_type: "session_start", session_id: "s3" }),
      evt({ timestamp: "2026-03-27T12:30:00Z", event_type: "session_end", session_id: "s3", duration_ms: 5_000_000 }),
    ];
    const summary = aggregateSummary(events, "mpg", new Date("2026-03-27T00:00:00Z"), new Date("2026-03-28T00:00:00Z"));
    assert.equal(summary.median_duration_ms, 2_000_000);
  });
});

describe("bucketSessions", () => {
  it("buckets sessions by hour", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:30:00Z", event_type: "session_start", session_id: "s2" }),
      evt({ timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s3" }),
    ];
    const result = bucketSessions(events, "hour");
    assert.equal(result.bucket_size, "hour");
    assert.equal(result.buckets.length, 2);
    assert.equal(result.buckets[0].bucket, "2026-03-27T10");
    assert.equal(result.buckets[0].session_count, 2);
    assert.equal(result.buckets[1].bucket, "2026-03-27T11");
    assert.equal(result.buckets[1].session_count, 1);
  });

  it("buckets sessions by day", () => {
    const events: MpgSessionEvent[] = [
      evt({ timestamp: "2026-03-26T10:00:00Z", event_type: "session_start", session_id: "s1" }),
      evt({ timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s2" }),
      evt({ timestamp: "2026-03-27T14:00:00Z", event_type: "session_start", session_id: "s3" }),
    ];
    const result = bucketSessions(events, "day");
    assert.equal(result.bucket_size, "day");
    assert.equal(result.buckets.length, 2);
    assert.equal(result.buckets[0].bucket, "2026-03-26");
    assert.equal(result.buckets[0].session_count, 1);
    assert.equal(result.buckets[1].bucket, "2026-03-27");
    assert.equal(result.buckets[1].session_count, 2);
  });
});
