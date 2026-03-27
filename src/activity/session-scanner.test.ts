import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSessionFile, scanSessions } from "./session-scanner.js";

const tmp = join(tmpdir(), "pulse-scanner-test-" + process.pid);

describe("scanSessionFile", () => {
  beforeEach(() => mkdirSync(tmp, { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("extracts session info from a JSONL file", () => {
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "abc-123", cwd: "/home/user/project" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:01:00.000Z", sessionId: "abc-123", cwd: "/home/user/project" }),
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:05:00.000Z", sessionId: "abc-123", cwd: "/home/user/project" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:06:00.000Z", sessionId: "abc-123", cwd: "/home/user/project" }),
    ];
    const filePath = join(tmp, "abc-123.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");

    const info = scanSessionFile(filePath);
    assert.ok(info);
    assert.equal(info.sessionId, "abc-123");
    assert.equal(info.startTimestamp, "2026-03-27T10:00:00.000Z");
    assert.equal(info.endTimestamp, "2026-03-27T10:06:00.000Z");
    assert.equal(info.projectDir, "/home/user/project");
    assert.ok(info.messageCount >= 1);
  });

  it("handles file-history-snapshot as first line", () => {
    const lines = [
      JSON.stringify({ type: "file-history-snapshot", timestamp: "2026-03-27T09:59:00.000Z", messageId: "snap-1", snapshot: {} }),
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "def-456", cwd: "/tmp/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:10:00.000Z", sessionId: "def-456", cwd: "/tmp/proj" }),
    ];
    const filePath = join(tmp, "def-456.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");

    const info = scanSessionFile(filePath);
    assert.ok(info);
    assert.equal(info.sessionId, "def-456");
    assert.equal(info.startTimestamp, "2026-03-27T09:59:00.000Z");
    assert.equal(info.endTimestamp, "2026-03-27T10:10:00.000Z");
    assert.equal(info.projectDir, "/tmp/proj");
  });

  it("returns null for empty file", () => {
    const filePath = join(tmp, "empty.jsonl");
    writeFileSync(filePath, "");
    assert.equal(scanSessionFile(filePath), null);
  });

  it("returns null for malformed file", () => {
    const filePath = join(tmp, "bad.jsonl");
    writeFileSync(filePath, "not json\nalso not json\n");
    assert.equal(scanSessionFile(filePath), null);
  });

  it("uses filename as session ID fallback", () => {
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", cwd: "/tmp/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:01:00.000Z", cwd: "/tmp/proj" }),
    ];
    const filePath = join(tmp, "fallback-id.jsonl");
    writeFileSync(filePath, lines.join("\n") + "\n");

    const info = scanSessionFile(filePath);
    assert.ok(info);
    assert.equal(info.sessionId, "fallback-id");
  });
});

describe("scanSessions", () => {
  const claudeDir = join(tmp, ".claude", "projects");

  beforeEach(() => mkdirSync(claudeDir, { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function writeSession(projectName: string, sessionId: string, lines: string[]): void {
    const projectDir = join(claudeDir, projectName);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("discovers sessions from claude projects directory", () => {
    writeSession("-home-user-myproject", "sess-1", [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "sess-1", cwd: "/home/user/myproject" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:30:00.000Z", sessionId: "sess-1", cwd: "/home/user/myproject" }),
    ]);

    const events = scanSessions(claudeDir);
    const starts = events.filter((e) => e.event_type === "session_start");
    const ends = events.filter((e) => e.event_type === "session_end");
    const msgs = events.filter((e) => e.event_type === "message_routed");

    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].session_id, "sess-1");
    assert.equal(starts[0].project_dir, "/home/user/myproject");
    assert.ok(msgs.length >= 1);
    assert.ok(ends[0].duration_ms! > 0);
  });

  it("returns empty array when claude dir does not exist", () => {
    const events = scanSessions(join(tmp, "nonexistent"));
    assert.deepStrictEqual(events, []);
  });

  it("filters by after date", () => {
    writeSession("-home-user-old", "sess-old", [
      JSON.stringify({ type: "user", timestamp: "2026-03-01T10:00:00.000Z", sessionId: "sess-old", cwd: "/home/user/old" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-01T10:30:00.000Z", sessionId: "sess-old", cwd: "/home/user/old" }),
    ]);
    writeSession("-home-user-new", "sess-new", [
      JSON.stringify({ type: "user", timestamp: "2026-03-26T10:00:00.000Z", sessionId: "sess-new", cwd: "/home/user/new" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-26T10:30:00.000Z", sessionId: "sess-new", cwd: "/home/user/new" }),
    ]);

    const after = new Date("2026-03-20T00:00:00.000Z");
    const events = scanSessions(claudeDir, { after });
    const starts = events.filter((e) => e.event_type === "session_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].session_id, "sess-new");
  });

  it("filters by project key", () => {
    writeSession("-home-user-alpha", "sess-a", [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "sess-a", cwd: "/home/user/alpha" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:30:00.000Z", sessionId: "sess-a", cwd: "/home/user/alpha" }),
    ]);
    writeSession("-home-user-beta", "sess-b", [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "sess-b", cwd: "/home/user/beta" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:30:00.000Z", sessionId: "sess-b", cwd: "/home/user/beta" }),
    ]);

    const events = scanSessions(claudeDir, { project: "-home-user-alpha" });
    const starts = events.filter((e) => e.event_type === "session_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].session_id, "sess-a");
  });

  it("ignores non-jsonl files and subdirectories", () => {
    const projDir = join(claudeDir, "-home-user-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "sess-1.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "sess-1", cwd: "/home/user/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:30:00.000Z", sessionId: "sess-1", cwd: "/home/user/proj" }),
    ].join("\n") + "\n");
    // Non-JSONL file
    writeFileSync(join(projDir, "notes.txt"), "not a session");
    // Subdirectory with its own JSONL (subagent — should be ignored by readdirSync filter)
    const subDir = join(projDir, "sess-1");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "subagents.jsonl"), "{}");

    const events = scanSessions(claudeDir);
    const starts = events.filter((e) => e.event_type === "session_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].session_id, "sess-1");
  });

  it("skips malformed JSONL files gracefully", () => {
    const projDir = join(claudeDir, "-home-user-proj");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "bad-sess.jsonl"), "not json\n");
    writeFileSync(join(projDir, "good-sess.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-03-27T10:00:00.000Z", sessionId: "good-sess", cwd: "/home/user/proj" }),
      JSON.stringify({ type: "assistant", timestamp: "2026-03-27T10:30:00.000Z", sessionId: "good-sess", cwd: "/home/user/proj" }),
    ].join("\n") + "\n");

    const events = scanSessions(claudeDir);
    const starts = events.filter((e) => e.event_type === "session_start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].session_id, "good-sess");
  });
});
