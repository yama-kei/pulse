import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEvents } from "./reader.js";
import { aggregateSessions, aggregateSummary } from "./aggregator.js";

let tmpDirs: string[] = [];

function setupEventsDir(): { eventsDir: string; base: string } {
  const base = mkdtempSync(join(tmpdir(), "pulse-cli-test-"));
  const eventsDir = join(base, "events");
  mkdirSync(eventsDir, { recursive: true });
  tmpDirs.push(base);
  return { eventsDir, base };
}

function writeFixture(eventsDir: string, source: string): void {
  const lines = [
    JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-25T08:00:00Z",
      event_type: "session_start",
      session_id: "s1",
      project_key: "my-project",
      project_dir: "/tmp/my-project",
      agent_name: "coder",
      trigger_source: "chan-1",
    }),
    JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-25T08:30:00Z",
      event_type: "message_routed",
      session_id: "s1",
      project_key: "my-project",
      project_dir: "/tmp/my-project",
      agent_target: "coder",
      queue_depth: 2,
    }),
    JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-25T09:00:00Z",
      event_type: "session_end",
      session_id: "s1",
      project_key: "my-project",
      project_dir: "/tmp/my-project",
      duration_ms: 3600000,
      message_count: 15,
    }),
  ];
  writeFileSync(join(eventsDir, `${source}.jsonl`), lines.join("\n") + "\n");
}

afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true }); } catch {} }
  tmpDirs = [];
});

describe("end-to-end: reader → aggregator pipeline", () => {
  it("reads events and produces a sessions envelope", () => {
    const { eventsDir } = setupEventsDir();
    writeFixture(eventsDir, "mpg-sessions");

    const events = readEvents("mpg-sessions", { eventsDir });
    const result = aggregateSessions("mpg-sessions", events, { range: "7d" });

    assert.equal(result.source, "mpg-sessions");
    assert.equal(result.events.length, 3);
    assert.equal(result.events[0].event_type, "session_start");
  });

  it("reads events and produces a summary with all fields populated", () => {
    const { eventsDir } = setupEventsDir();
    writeFixture(eventsDir, "mpg-sessions");

    const events = readEvents("mpg-sessions", { eventsDir });
    const result = aggregateSummary("mpg-sessions", events, "day", { range: "7d" });

    assert.equal(result.bucket, "day");
    assert.ok(result.sessions_per_bucket.length > 0);
    assert.ok(result.duration_stats.length > 0);
    assert.ok(result.message_volume.length > 0);
    assert.ok(result.persona_breakdown.length > 0);
    assert.ok(result.peak_concurrent.length > 0);

    // Verify specific values
    assert.equal(result.duration_stats[0].avg_ms, 3600000);
    assert.equal(result.persona_breakdown.find(p => p.agent === "coder")?.count, 1);
  });

  it("gc removes old events and keeps recent ones", () => {
    const { eventsDir } = setupEventsDir();
    const filePath = join(eventsDir, "test-gc.jsonl");

    const old = JSON.stringify({
      schema_version: 1,
      timestamp: "2020-01-01T00:00:00Z",
      event_type: "session_start",
      session_id: "old",
      project_key: "proj",
      project_dir: "/tmp/proj",
      trigger_source: "chan-1",
    });
    const recent = JSON.stringify({
      schema_version: 1,
      timestamp: new Date().toISOString(),
      event_type: "session_start",
      session_id: "new",
      project_key: "proj",
      project_dir: "/tmp/proj",
      trigger_source: "chan-1",
    });
    writeFileSync(filePath, [old, recent].join("\n") + "\n");

    // Simulate gc: read, filter, rewrite
    const content = readFileSync(filePath, "utf-8");
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const kept = content.split("\n").filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed);
        return new Date(parsed.timestamp) >= cutoff;
      } catch {
        return true;
      }
    });
    writeFileSync(filePath, kept.join("\n") + "\n");

    const remaining = readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim());
    assert.equal(remaining.length, 1);
    assert.ok(remaining[0].includes('"new"'));
  });
});
