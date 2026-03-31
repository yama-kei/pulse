import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractWorktreeInfo,
  extractProjectName,
  discoverThreads,
  formatSessions,
} from "./sessions.js";

describe("extractWorktreeInfo", () => {
  it("extracts worktree ID and main role from base worktree dir", () => {
    const result = extractWorktreeInfo("-home-yamakei-Documents-pulse--worktrees-1487714248284180510");
    assert.deepEqual(result, { worktreeId: "1487714248284180510", role: "main" });
  });

  it("extracts worktree ID and pm role", () => {
    const result = extractWorktreeInfo("-home-yamakei-Documents-pulse--worktrees-1487714248284180510-pm");
    assert.deepEqual(result, { worktreeId: "1487714248284180510", role: "pm" });
  });

  it("extracts worktree ID and engineer role", () => {
    const result = extractWorktreeInfo("-home-yamakei-Documents-pulse--worktrees-1487714248284180510-engineer");
    assert.deepEqual(result, { worktreeId: "1487714248284180510", role: "engineer" });
  });

  it("returns null for non-worktree directories", () => {
    assert.equal(extractWorktreeInfo("-home-yamakei-Documents-pulse"), null);
  });

  it("returns null for directories that look similar but don't match", () => {
    assert.equal(extractWorktreeInfo("-home-yamakei-worktrees-abc"), null);
  });
});

describe("extractProjectName", () => {
  it("extracts project name from worktree directory", () => {
    const name = extractProjectName("-home-yamakei-Documents-pulse--worktrees-1487714248284180510-engineer");
    assert.equal(name, "pulse");
  });

  it("extracts project name from non-worktree directory", () => {
    const name = extractProjectName("-home-yamakei-Documents-myproject");
    assert.equal(name, "myproject");
  });

  it("handles deep paths", () => {
    const name = extractProjectName("-home-yamakei-Documents-multi-project-gateway--worktrees-12345");
    assert.equal(name, "gateway");
  });
});

describe("discoverThreads", () => {
  const tmp = join(tmpdir(), "pulse-sessions-test-" + process.pid);
  const claudeDir = join(tmp, ".claude", "projects");

  // Override HOME to use our temp dir
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSession(dirName: string, sessionId: string, lines: string[]): void {
    const dir = join(claudeDir, dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  function sessionLines(sessionId: string, start: string, end: string): string[] {
    return [
      JSON.stringify({ type: "user", timestamp: start, sessionId, cwd: "/tmp/proj" }),
      JSON.stringify({ type: "assistant", timestamp: end, sessionId, cwd: "/tmp/proj" }),
    ];
  }

  it("groups sessions by worktree ID", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3600000).toISOString(); // 1h ago
    const recentEnd = new Date(now.getTime() - 1800000).toISOString(); // 30min ago

    writeSession(
      "-home-user-proj--worktrees-12345",
      "sess-main",
      sessionLines("sess-main", recent, recentEnd)
    );
    writeSession(
      "-home-user-proj--worktrees-12345-pm",
      "sess-pm",
      sessionLines("sess-pm", recent, recentEnd)
    );
    writeSession(
      "-home-user-proj--worktrees-12345-engineer",
      "sess-eng",
      sessionLines("sess-eng", recent, recentEnd)
    );

    const groups = discoverThreads();
    const thread = groups.find((g) => g.worktreeId === "12345");
    assert.ok(thread);
    assert.equal(thread.sessions.length, 3);

    const roles = thread.sessions.map((s) => s.role).sort();
    assert.deepEqual(roles, ["engineer", "main", "pm"]);
  });

  it("places non-worktree sessions as standalone", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3600000).toISOString();
    const recentEnd = new Date(now.getTime() - 1800000).toISOString();

    writeSession(
      "-home-user-standalone-proj",
      "sess-solo",
      sessionLines("sess-solo", recent, recentEnd)
    );

    const groups = discoverThreads();
    const standalone = groups.find((g) => g.worktreeId === "");
    assert.ok(standalone);
    assert.equal(standalone.sessions.length, 1);
    assert.equal(standalone.sessions[0].role, "standalone");
  });

  it("returns empty array when no sessions exist", () => {
    const groups = discoverThreads();
    assert.deepEqual(groups, []);
  });

  it("filters sessions by range", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3600000).toISOString(); // 1h ago
    const recentEnd = new Date(now.getTime() - 1800000).toISOString();
    const old = "2020-01-01T00:00:00.000Z";
    const oldEnd = "2020-01-01T01:00:00.000Z";

    writeSession(
      "-home-user-proj--worktrees-111",
      "sess-new",
      sessionLines("sess-new", recent, recentEnd)
    );
    writeSession(
      "-home-user-proj--worktrees-222",
      "sess-old",
      sessionLines("sess-old", old, oldEnd)
    );

    const groups = discoverThreads({ range: "1d" });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].worktreeId, "111");
  });

  it("sorts groups by most recent activity", () => {
    const now = new Date();
    const t1 = new Date(now.getTime() - 7200000).toISOString(); // 2h ago
    const t1End = new Date(now.getTime() - 6000000).toISOString();
    const t2 = new Date(now.getTime() - 3600000).toISOString(); // 1h ago
    const t2End = new Date(now.getTime() - 1800000).toISOString();

    writeSession("-home-user-proj--worktrees-11111", "s1", sessionLines("s1", t1, t1End));
    writeSession("-home-user-proj--worktrees-22222", "s2", sessionLines("s2", t2, t2End));

    const groups = discoverThreads();
    assert.equal(groups[0].worktreeId, "22222");
    assert.equal(groups[1].worktreeId, "11111");
  });
});

describe("formatSessions", () => {
  it("returns helpful message when no sessions found", () => {
    const output = formatSessions([]);
    assert.ok(output.includes("No sessions found"));
  });

  it("formats thread groups with roles and time ranges", () => {
    const output = formatSessions([
      {
        worktreeId: "12345",
        project: "pulse",
        latestTimestamp: "2026-03-29T14:00:00.000Z",
        sessions: [
          {
            role: "main",
            messageCount: 5,
            startTimestamp: "2026-03-29T12:00:00.000Z",
            endTimestamp: "2026-03-29T13:00:00.000Z",
            filePath: "/home/user/.claude/projects/dir/sess.jsonl",
            dirName: "-home-user-proj--worktrees-12345",
          },
          {
            role: "pm",
            messageCount: 3,
            startTimestamp: "2026-03-29T13:00:00.000Z",
            endTimestamp: "2026-03-29T14:00:00.000Z",
            filePath: "/home/user/.claude/projects/dir-pm/sess.jsonl",
            dirName: "-home-user-proj--worktrees-12345-pm",
          },
        ],
      },
    ]);

    assert.ok(output.includes("Thread 12345"));
    assert.ok(output.includes("pulse"));
    assert.ok(output.includes("main"));
    assert.ok(output.includes("pm"));
    assert.ok(output.includes("5 msgs"));
    assert.ok(output.includes("3 msgs"));
  });

  it("formats standalone sessions without thread header", () => {
    const output = formatSessions([
      {
        worktreeId: "",
        project: "myproject",
        latestTimestamp: "2026-03-29T12:00:00.000Z",
        sessions: [
          {
            role: "standalone",
            messageCount: 10,
            startTimestamp: "2026-03-29T11:00:00.000Z",
            endTimestamp: "2026-03-29T12:00:00.000Z",
            filePath: "/home/user/.claude/projects/dir/sess.jsonl",
            dirName: "-home-user-myproject",
          },
        ],
      },
    ]);

    assert.ok(output.includes("myproject (standalone)"));
    assert.ok(output.includes("10 msgs"));
  });
});
