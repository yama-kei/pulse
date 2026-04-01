import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { extractConvergence, computeAgentBreakdown } from "./convergence.js";
import { CorrelatedMpgData, MpgSessionEvent } from "../types/pulse.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createSessionFile(messages: Array<{ type: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-conv-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  const lines = messages.map(m =>
    JSON.stringify({
      type: m.type,
      message: { role: m.type === "user" ? "user" : "assistant", content: m.content },
    })
  );
  writeFileSync(filePath, lines.join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

/** Create a session JSONL with raw JSON lines (for tool_use blocks) */
function createRawSessionFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-conv-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

function toolUseMsg(toolName: string, input: Record<string, unknown>): object {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: toolName, input }],
    },
  };
}

function userMsg(text: string): object {
  return {
    type: "user",
    message: { role: "user", content: text },
  };
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of tmpDirs) { try { rmdirSync(d); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

describe("extractConvergence", () => {
  it("returns zero signal with no session file", () => {
    const result = extractConvergence(null, 5);
    assert.equal(result.exchanges, 0);
    assert.equal(result.outcomes, 5);
    assert.equal(result.rate, 0);
    assert.equal(result.reworkInstances, 0);
    assert.equal(result.reworkPercent, 0);
  });

  it("floors outcomes at 1 to avoid division by zero", () => {
    const result = extractConvergence(null, 0);
    assert.equal(result.outcomes, 1);
  });

  it("filters out system/skill messages from exchange and rework counts", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the login bug" },
      { type: "user", content: "Base directory for this skill: /home/user/.claude/plugins/cache/superpowers/skills/exec" },
      { type: "user", content: "this is wrong, revert it" },
      { type: "user", content: "something about /.claude/plugins/ path" },
    ]);
    const result = extractConvergence(session, 3);
    // Only 2 real user messages counted (system messages filtered)
    assert.equal(result.exchanges, 2);
    // Only the real "wrong, revert" message counts as rework
    assert.equal(result.reworkInstances, 1);
  });

  it("counts Write tool calls as outcomes", () => {
    const session = createRawSessionFile([
      userMsg("create two files"),
      toolUseMsg("Write", { file_path: "/tmp/a.ts", content: "a" }),
      toolUseMsg("Write", { file_path: "/tmp/b.ts", content: "b" }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
  });

  it("counts Edit tool calls as outcomes, deduplicating by file path", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" }),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "y", new_string: "z" }),
      toolUseMsg("Edit", { file_path: "/tmp/b.ts", old_string: "1", new_string: "2" }),
    ]);
    const result = extractConvergence(session, 0);
    // 2 unique files edited, not 3
    assert.equal(result.outcomes, 2);
  });

  it("counts git commit Bash commands as outcomes", () => {
    const session = createRawSessionFile([
      userMsg("commit the changes"),
      toolUseMsg("Bash", { command: 'git commit -m "fix: something"' }),
      toolUseMsg("Bash", { command: 'git add . && git commit -m "feat: other"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
  });

  it("counts gh pr create and gh issue create as outcomes", () => {
    const session = createRawSessionFile([
      userMsg("create a PR and an issue"),
      toolUseMsg("Bash", { command: 'gh pr create --title "fix" --body "desc"' }),
      toolUseMsg("Bash", { command: 'gh issue create --title "bug" --body "desc"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
  });

  it("combines file edits, commits, and PRs without double-counting files", () => {
    const session = createRawSessionFile([
      userMsg("fix and ship"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" }),
      toolUseMsg("Write", { file_path: "/tmp/b.ts", content: "new" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix: a bug"' }),
      toolUseMsg("Bash", { command: 'gh pr create --title "fix"' }),
    ]);
    const result = extractConvergence(session, 0);
    // 2 unique files + 1 commit + 1 PR = 4
    assert.equal(result.outcomes, 4);
  });

  it("floors outcomes at 1 when session has no deliverables", () => {
    const session = createRawSessionFile([
      userMsg("explain how this works"),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 1);
  });

  it("uses max of session outcomes and filesChanged", () => {
    // Session has 1 Write, but git shows 5 files changed
    const session = createRawSessionFile([
      userMsg("do stuff"),
      toolUseMsg("Write", { file_path: "/tmp/a.ts", content: "a" }),
    ]);
    const result = extractConvergence(session, 5);
    assert.equal(result.outcomes, 5);
  });
});

describe("rework detection", () => {
  it("detects 'actually' followed by punctuation (not just comma/space)", () => {
    const session = createSessionFile([
      { type: "user", content: "actually... let me rethink this" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 1);
  });

  it("detects 'try again' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "that didn't work, try again" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 1);
  });

  it("detects 'wait' and 'hold on' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "wait, that's not right" },
      { type: "user", content: "hold on, I changed my mind" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("detects 'never mind' and 'scratch that' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "never mind that approach" },
      { type: "user", content: "scratch that, do it differently" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("detects 'not what I meant' and 'not correct' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "that's not what I meant" },
      { type: "user", content: "that's not correct" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("does not false-positive on normal instructions", () => {
    const session = createSessionFile([
      { type: "user", content: "add a login form to the page" },
      { type: "user", content: "now add validation for the email field" },
      { type: "user", content: "can you also add a password strength indicator" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 0);
  });

  it("detects 'not fixed' and 'didn't fix' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "Not fixed even after I restart" },
      { type: "user", content: "that didn't fix the issue" },
      { type: "user", content: "this doesn't fix anything" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 3);
  });

  it("detects 'still *ing' and 'still + present tense' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "still expanding vertically as it loads" },
      { type: "user", content: "still failing on the same test" },
      { type: "user", content: "it still expands vertically as it loads" },
      { type: "user", content: "the chart still shows the same problem" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 4);
  });

  it("detects 'got worse' and 'getting worse' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "it got worse after that change" },
      { type: "user", content: "the performance is getting worse" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("detects 'didn't work/help/change' and 'doesn't work/help' and 'not working' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "that didn't work at all" },
      { type: "user", content: "this doesn't work either" },
      { type: "user", content: "it's not working" },
      { type: "user", content: "that didn't help" },
      { type: "user", content: "didn't change anything" },
      { type: "user", content: "this doesn't help at all" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 6);
  });

  it("detects 'same issue/problem/error/bug' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "same issue as before" },
      { type: "user", content: "same problem, nothing changed" },
      { type: "user", content: "same error in the logs" },
      { type: "user", content: "same bug, it's back" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 4);
  });

  it("detects 'no change/difference/improvement/effect' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "no change from the last attempt" },
      { type: "user", content: "no difference after applying the fix" },
      { type: "user", content: "no improvement at all" },
      { type: "user", content: "no effect on the rendering" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 4);
  });

  it("does not false-positive 'still' in normal context", () => {
    const session = createSessionFile([
      { type: "user", content: "I still need to add the tests" },
      { type: "user", content: "we still want this feature" },
      { type: "user", content: "I still want to add logging" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 0);
  });
});

describe("duplicate commit deduplication", () => {
  it("deduplicates commits with the same issue ref", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): make bars thicker"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): actually make bars thicker"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 1);
    assert.equal(result.duplicateCommits, 1);
  });

  it("counts commits with different issue refs as separate outcomes", () => {
    const session = createRawSessionFile([
      userMsg("fix bugs"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): bars"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#94): colors"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
    assert.equal(result.duplicateCommits, 0);
  });

  it("counts commits without issue refs individually", () => {
    const session = createRawSessionFile([
      userMsg("do stuff"),
      toolUseMsg("Bash", { command: 'git commit -m "fix something"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix something else"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
    assert.equal(result.duplicateCommits, 0);
  });

  it("counts mixed ref and no-ref commits correctly", () => {
    const session = createRawSessionFile([
      userMsg("fix"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): first"' }),
      toolUseMsg("Bash", { command: 'git commit -m "unrelated change"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
    assert.equal(result.duplicateCommits, 0);
  });

  it("handles single-quoted commit messages", () => {
    const session = createRawSessionFile([
      userMsg("fix"),
      toolUseMsg("Bash", { command: "git commit -m 'fix(#93): first'" }),
      toolUseMsg("Bash", { command: "git commit -m 'fix(#93): second'" }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 1);
    assert.equal(result.duplicateCommits, 1);
  });

  it("returns duplicateCommits 0 when no session file", () => {
    const result = extractConvergence(null, 5);
    assert.equal(result.duplicateCommits, 0);
  });
});

describe("MPG enrichment — per-agent convergence", () => {
  function makeMpgEvent(overrides: Partial<MpgSessionEvent>): MpgSessionEvent {
    return {
      schema_version: 1,
      timestamp: "2026-03-30T10:00:00Z",
      event_type: "message_routed",
      session_id: "test-session",
      project_key: "test",
      project_dir: "/test",
      ...overrides,
    };
  }

  it("returns no agentBreakdown when mpgData is undefined", () => {
    const result = extractConvergence(null, 5);
    assert.equal(result.agentBreakdown, undefined);
  });

  it("returns no agentBreakdown when mpgData is null", () => {
    const result = extractConvergence(null, 5, null);
    assert.equal(result.agentBreakdown, undefined);
  });

  it("returns no agentBreakdown when mpgData has no events", () => {
    const result = extractConvergence(null, 5, { sessionId: "s", events: [] });
    assert.equal(result.agentBreakdown, undefined);
  });

  it("computes per-agent breakdown from MPG message_routed events", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        makeMpgEvent({ agent_target: "engineer" }),
        makeMpgEvent({ agent_target: "engineer" }),
        makeMpgEvent({ agent_target: "engineer", is_error: true, error_type: "tool_failure" }),
        makeMpgEvent({ agent_target: "pm" }),
        makeMpgEvent({ event_type: "session_start" }), // should be skipped
      ],
    };
    const result = extractConvergence(null, 5, mpgData);
    assert.ok(result.agentBreakdown);
    assert.equal(result.agentBreakdown!.length, 2);

    const engineer = result.agentBreakdown!.find(a => a.agent === "engineer");
    assert.ok(engineer);
    assert.equal(engineer!.messages, 3);
    assert.equal(engineer!.errors, 1);
    assert.equal(engineer!.errorRate, 33.3);
    assert.equal(engineer!.convergencePenalty, 0.5);

    const pm = result.agentBreakdown!.find(a => a.agent === "pm");
    assert.ok(pm);
    assert.equal(pm!.messages, 1);
    assert.equal(pm!.errors, 0);
    assert.equal(pm!.errorRate, 0);
    assert.equal(pm!.convergencePenalty, 0);
  });

  it("sorts agents by message count descending", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        makeMpgEvent({ agent_target: "qa" }),
        makeMpgEvent({ agent_target: "engineer" }),
        makeMpgEvent({ agent_target: "engineer" }),
        makeMpgEvent({ agent_target: "engineer" }),
      ],
    };
    const breakdown = computeAgentBreakdown(mpgData);
    assert.equal(breakdown[0].agent, "engineer");
    assert.equal(breakdown[1].agent, "qa");
  });

  it("falls back to persona when agent_target is not set", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        makeMpgEvent({ agent_target: undefined, persona: "reviewer" }),
      ],
    };
    const breakdown = computeAgentBreakdown(mpgData);
    assert.equal(breakdown[0].agent, "reviewer");
  });

  it("falls back to agent_name from session_start when agent_target and persona are absent", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test-session",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T09:59:00Z", event_type: "session_start", session_id: "test-session", project_key: "test", project_dir: "/test", agent_name: "architect" },
        makeMpgEvent({ agent_target: undefined, persona: undefined }),
      ],
    };
    const breakdown = computeAgentBreakdown(mpgData);
    assert.equal(breakdown[0].agent, "architect");
  });
});
