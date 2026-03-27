import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { runActivity } from "./activity.js";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

let tmpDirs: string[] = [];

function createEventsDir(baseDir: string, lines: string[]): void {
  const eventsDir = join(baseDir, "events");
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(join(eventsDir, "mpg-sessions.jsonl"), lines.join("\n") + "\n");
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-activity-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { execSync(`rm -rf "${d}"`); } catch {}
  }
  tmpDirs = [];
});

describe("runActivity", () => {
  it("sessions subcommand returns JSON array", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", project_key: "proj", project_dir: "/tmp", duration_ms: 1800000 }),
    ]);
    const result = runActivity(["sessions", "--source", "mpg", "--range", "7d", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].session_id, "s1");
  });

  it("summary subcommand returns JSON object", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:30:00Z", event_type: "session_end", session_id: "s1", project_key: "proj", project_dir: "/tmp", duration_ms: 1800000 }),
    ]);
    const result = runActivity(["summary", "--source", "mpg", "--range", "7d", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.total_sessions, 1);
    assert.equal(parsed.total_messages, 1);
  });

  it("gc subcommand with --dry-run returns count", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2020-01-01T00:00:00Z", event_type: "session_start", session_id: "old", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "new", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["gc", "--source", "mpg", "--retain", "30d", "--dry-run"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.dry_run, true);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.retained, 1);
  });

  it("defaults source to mpg and range to 7d", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["sessions", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 1);
  });

  it("returns empty results for missing events file", () => {
    const dir = makeTmpDir();
    const result = runActivity(["sessions", "--source", "mpg", "--range", "7d", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed, []);
  });

  it("filters by --project", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "alpha", project_dir: "/tmp/a" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s2", project_key: "beta", project_dir: "/tmp/b" }),
    ]);
    const result = runActivity(["sessions", "--source", "mpg", "--project", "alpha", "--range", "7d", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].project_key, "alpha");
  });

  it("gc without --dry-run rewrites the file", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2020-01-01T00:00:00Z", event_type: "session_start", session_id: "old", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "new", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["gc", "--source", "mpg", "--retain", "30d"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.dry_run, false);
    assert.equal(parsed.removed, 1);
    assert.equal(parsed.retained, 1);
    const content = readFileSync(join(dir, "events", "mpg-sessions.jsonl"), "utf-8");
    const remaining = content.trim().split("\n").map(l => JSON.parse(l));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].session_id, "new");
  });

  it("rejects invalid --bucket values", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["sessions", "--source", "mpg", "--range", "7d", "--bucket", "week"], dir);
    assert.ok(result.startsWith("Error:"));
    assert.ok(result.includes("week"));
  });

  it("sessions with --bucket returns bucketed data", () => {
    const dir = makeTmpDir();
    createEventsDir(dir, [
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T11:00:00Z", event_type: "session_start", session_id: "s2", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const result = runActivity(["sessions", "--source", "mpg", "--range", "7d", "--bucket", "hour", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.bucket_size, "hour");
    assert.equal(parsed.buckets.length, 2);
  });

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
});
