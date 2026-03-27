import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readEvents } from "./reader.js";
import { writeFileSync, mkdtempSync, mkdirSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDirs: string[] = [];

function createEventsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-reader-test-"));
  const eventsDir = join(dir, "events");
  mkdirSync(eventsDir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(dir: string, source: string, lines: string[]): void {
  writeFileSync(join(dir, "events", `${source}.jsonl`), lines.join("\n") + "\n");
}

afterEach(() => {
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true }); } catch {} }
  tmpDirs = [];
});

describe("readEvents", () => {
  it("returns empty array for missing file", () => {
    const result = readEvents("nonexistent", { eventsDir: "/tmp/no-such-dir/events" });
    assert.deepEqual(result, []);
  });

  it("returns empty array for empty file", () => {
    const base = createEventsDir();
    writeFileSync(join(base, "events", "test.jsonl"), "");
    const result = readEvents("test", { eventsDir: join(base, "events") });
    assert.deepEqual(result, []);
  });

  it("parses valid session events", () => {
    const base = createEventsDir();
    const event = JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T10:00:00Z",
      event_type: "session_start",
      session_id: "s1",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", [event]);
    const result = readEvents("test", { eventsDir: join(base, "events") });
    assert.equal(result.length, 1);
    assert.equal(result[0].event_type, "session_start");
    assert.equal(result[0].session_id, "s1");
  });

  it("skips malformed lines without throwing", () => {
    const base = createEventsDir();
    const good = JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T10:00:00Z",
      event_type: "session_start",
      session_id: "s1",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", ["not json", good, "{incomplete"]);
    const result = readEvents("test", { eventsDir: join(base, "events") });
    assert.equal(result.length, 1);
  });

  it("skips events with unknown schema_version", () => {
    const base = createEventsDir();
    const v1 = JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T10:00:00Z",
      event_type: "session_start",
      session_id: "s1",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    const v99 = JSON.stringify({
      schema_version: 99,
      timestamp: "2026-03-26T11:00:00Z",
      event_type: "session_start",
      session_id: "s2",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", [v1, v99]);
    const result = readEvents("test", { eventsDir: join(base, "events") });
    assert.equal(result.length, 1);
    assert.equal(result[0].session_id, "s1");
  });

  it("filters by time range (since/until)", () => {
    const base = createEventsDir();
    const makeEvent = (ts: string, id: string) => JSON.stringify({
      schema_version: 1,
      timestamp: ts,
      event_type: "session_start",
      session_id: id,
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", [
      makeEvent("2026-03-20T10:00:00Z", "old"),
      makeEvent("2026-03-25T10:00:00Z", "mid"),
      makeEvent("2026-03-27T10:00:00Z", "new"),
    ]);
    const result = readEvents("test", {
      eventsDir: join(base, "events"),
      since: new Date("2026-03-24T00:00:00Z"),
      until: new Date("2026-03-26T00:00:00Z"),
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].session_id, "mid");
  });

  it("filters by project key", () => {
    const base = createEventsDir();
    const makeEvent = (proj: string, id: string) => JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T10:00:00Z",
      event_type: "session_start",
      session_id: id,
      project_key: proj,
      project_dir: `/tmp/${proj}`,
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", [
      makeEvent("proj-a", "s1"),
      makeEvent("proj-b", "s2"),
      makeEvent("proj-a", "s3"),
    ]);
    const result = readEvents("test", {
      eventsDir: join(base, "events"),
      projectKey: "proj-a",
    });
    assert.equal(result.length, 2);
    assert.ok(result.every(e => e.project_key === "proj-a"));
  });

  it("filters by event type", () => {
    const base = createEventsDir();
    const start = JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T10:00:00Z",
      event_type: "session_start",
      session_id: "s1",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    const end = JSON.stringify({
      schema_version: 1,
      timestamp: "2026-03-26T11:00:00Z",
      event_type: "session_end",
      session_id: "s1",
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      duration_ms: 3600000,
      message_count: 10,
    });
    writeJsonl(base, "test", [start, end]);
    const result = readEvents("test", {
      eventsDir: join(base, "events"),
      eventType: "session_end",
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].event_type, "session_end");
  });

  it("returns events sorted by timestamp", () => {
    const base = createEventsDir();
    const makeEvent = (ts: string, id: string) => JSON.stringify({
      schema_version: 1,
      timestamp: ts,
      event_type: "session_start",
      session_id: id,
      project_key: "proj-a",
      project_dir: "/tmp/proj-a",
      trigger_source: "chan-1",
    });
    writeJsonl(base, "test", [
      makeEvent("2026-03-26T12:00:00Z", "late"),
      makeEvent("2026-03-26T08:00:00Z", "early"),
      makeEvent("2026-03-26T10:00:00Z", "mid"),
    ]);
    const result = readEvents("test", { eventsDir: join(base, "events") });
    assert.equal(result[0].session_id, "early");
    assert.equal(result[1].session_id, "mid");
    assert.equal(result[2].session_id, "late");
  });
});
