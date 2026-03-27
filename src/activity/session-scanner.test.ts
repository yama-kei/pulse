import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSessionFile } from "./session-scanner.js";

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
