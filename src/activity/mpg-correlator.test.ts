import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { readMpgEvents, sessionIdFromPath, correlateMpgEvents } from "./mpg-correlator.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MpgSessionEvent } from "../types/pulse.js";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createEventsFile(events: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-mpg-test-"));
  tmpDirs.push(dir);
  const eventsDir = join(dir, "events");
  mkdirSync(eventsDir, { recursive: true });
  const filePath = join(eventsDir, "mpg-sessions.jsonl");
  writeFileSync(filePath, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of [...tmpDirs].reverse()) { try { rmdirSync(d, { recursive: true } as any); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

describe("readMpgEvents", () => {
  it("returns empty array when file does not exist", () => {
    const events = readMpgEvents("/nonexistent/path/mpg-sessions.jsonl");
    assert.deepEqual(events, []);
  });

  it("parses valid events from JSONL", () => {
    const path = createEventsFile([
      { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "abc-123", project_key: "test", project_dir: "/test" },
      { schema_version: 1, timestamp: "2026-03-30T10:01:00Z", event_type: "message_routed", session_id: "abc-123", project_key: "test", project_dir: "/test", agent_target: "engineer" },
    ]);
    const events = readMpgEvents(path);
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, "session_start");
    assert.equal(events[1].agent_target, "engineer");
  });

  it("skips malformed lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "pulse-mpg-test-"));
    tmpDirs.push(dir);
    const eventsDir = join(dir, "events");
    mkdirSync(eventsDir, { recursive: true });
    const filePath = join(eventsDir, "mpg-sessions.jsonl");
    writeFileSync(filePath, "not json\n{\"invalid\": true}\n" +
      JSON.stringify({ schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "abc", project_key: "t", project_dir: "/t" }) + "\n");
    tmpFiles.push(filePath);
    const events = readMpgEvents(filePath);
    assert.equal(events.length, 1);
  });
});

describe("sessionIdFromPath", () => {
  it("extracts session ID from path", () => {
    assert.equal(sessionIdFromPath("/home/user/.claude/projects/foo/abc-123.jsonl"), "abc-123");
  });
});

describe("correlateMpgEvents", () => {
  it("returns null when sessionPath is null", () => {
    assert.equal(correlateMpgEvents(null), null);
  });

  it("returns null when no MPG events match", () => {
    const events: MpgSessionEvent[] = [
      { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "other-session", project_key: "t", project_dir: "/t" },
    ];
    const result = correlateMpgEvents("/path/to/my-session.jsonl", events);
    assert.equal(result, null);
  });

  it("returns correlated events for matching session ID", () => {
    const events: MpgSessionEvent[] = [
      { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "my-session", project_key: "t", project_dir: "/t" },
      { schema_version: 1, timestamp: "2026-03-30T10:01:00Z", event_type: "message_routed", session_id: "my-session", project_key: "t", project_dir: "/t", agent_target: "engineer" },
      { schema_version: 1, timestamp: "2026-03-30T10:02:00Z", event_type: "session_start", session_id: "other-session", project_key: "t", project_dir: "/t" },
    ];
    const result = correlateMpgEvents("/path/to/my-session.jsonl", events);
    assert.notEqual(result, null);
    assert.equal(result!.sessionId, "my-session");
    assert.equal(result!.events.length, 2);
  });

  it("returns null when events file does not exist", () => {
    const result = correlateMpgEvents("/path/to/session.jsonl", undefined, "/nonexistent/mpg-sessions.jsonl");
    assert.equal(result, null);
  });

  it("includes events from the same thread_id across different session IDs", () => {
    const events: MpgSessionEvent[] = [
      { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "my-session", project_key: "t", project_dir: "/t", thread_id: "thread-1" },
      { schema_version: 1, timestamp: "2026-03-30T10:01:00Z", event_type: "agent_handoff", session_id: "my-session", project_key: "t", project_dir: "/t", thread_id: "thread-1", from_agent: "pm", to_agent: "engineer" },
      { schema_version: 1, timestamp: "2026-03-30T10:02:00Z", event_type: "session_start", session_id: "other-session", project_key: "t", project_dir: "/t", thread_id: "thread-1", agent_name: "engineer" },
      { schema_version: 1, timestamp: "2026-03-30T10:03:00Z", event_type: "message_routed", session_id: "other-session", project_key: "t", project_dir: "/t", thread_id: "thread-1", agent_target: "engineer" },
      { schema_version: 1, timestamp: "2026-03-30T10:04:00Z", event_type: "session_start", session_id: "unrelated", project_key: "t", project_dir: "/t", thread_id: "thread-2" },
    ];
    const result = correlateMpgEvents("/path/to/my-session.jsonl", events);
    assert.notEqual(result, null);
    assert.equal(result!.sessionId, "my-session");
    assert.equal(result!.events.length, 4); // all thread-1 events, not the unrelated one
  });

  it("does not expand correlation when no thread_id is present", () => {
    const events: MpgSessionEvent[] = [
      { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "session_start", session_id: "my-session", project_key: "t", project_dir: "/t" },
      { schema_version: 1, timestamp: "2026-03-30T10:01:00Z", event_type: "message_routed", session_id: "other-session", project_key: "t", project_dir: "/t" },
    ];
    const result = correlateMpgEvents("/path/to/my-session.jsonl", events);
    assert.notEqual(result, null);
    assert.equal(result!.events.length, 1);
  });
});
