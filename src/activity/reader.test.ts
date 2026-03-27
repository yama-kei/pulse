import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readEvents } from "./reader.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDirs: string[] = [];

function createEventsDir(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-reader-test-"));
  const eventsDir = join(dir, "events");
  mkdirSync(eventsDir, { recursive: true });
  writeFileSync(join(eventsDir, "mpg-sessions.jsonl"), lines.join("\n") + "\n");
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      const { execSync } = require("node:child_process");
      execSync(`rm -rf "${d}"`);
    } catch {}
  }
  tmpDirs = [];
});

describe("readEvents", () => {
  it("returns empty array when file does not exist", () => {
    const events = readEvents("/nonexistent/path", "mpg");
    assert.deepStrictEqual(events, []);
  });

  it("reads and parses valid JSONL", () => {
    const dir = createEventsDir([
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:05:00Z", event_type: "message_routed", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const events = readEvents(dir, "mpg");
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, "session_start");
    assert.equal(events[1].event_type, "message_routed");
  });

  it("skips malformed lines without throwing", () => {
    const dir = createEventsDir([
      "not json",
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      "",
    ]);
    const events = readEvents(dir, "mpg");
    assert.equal(events.length, 1);
  });

  it("filters events by time range", () => {
    const dir = createEventsDir([
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-20T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s2", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const rangeStart = new Date("2026-03-25T00:00:00Z");
    const events = readEvents(dir, "mpg", { after: rangeStart });
    assert.equal(events.length, 1);
    assert.equal(events[0].session_id, "s2");
  });

  it("skips valid JSON missing required fields", () => {
    const dir = createEventsDir([
      JSON.stringify({ foo: "bar" }),
      JSON.stringify({ session_id: "s1", event_type: "session_start" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "proj", project_dir: "/tmp" }),
    ]);
    const events = readEvents(dir, "mpg");
    assert.equal(events.length, 1);
    assert.equal(events[0].session_id, "s1");
    assert.equal(events[0].project_key, "proj");
  });

  it("filters events by project", () => {
    const dir = createEventsDir([
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:00:00Z", event_type: "session_start", session_id: "s1", project_key: "alpha", project_dir: "/tmp/a" }),
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-27T10:01:00Z", event_type: "session_start", session_id: "s2", project_key: "beta", project_dir: "/tmp/b" }),
    ]);
    const events = readEvents(dir, "mpg", { project: "alpha" });
    assert.equal(events.length, 1);
    assert.equal(events[0].project_key, "alpha");
  });
});
