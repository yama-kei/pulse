import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { extractConvergence } from "./convergence.js";
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

  it("detects blind-retry patterns: 'not fixed', 'didn't work', 'still broken'", () => {
    const session = createSessionFile([
      { type: "user", content: "Not fixed even after I restart with latest changes" },
      { type: "user", content: "that didn't work, the chart is still broken" },
      { type: "user", content: "doesn't work, same issue" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 3);
  });

  it("detects 'got worse' and 'getting worse' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "No, it got worse...graphs are expanding even faster" },
      { type: "user", content: "it's getting worse with each change" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("detects 'still expanding', 'still happening' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "it still expands vertically as it loads more data" },
      { type: "user", content: "the error is still happening after the fix" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 2);
  });

  it("detects 'no change', 'no difference', 'no improvement' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "no change after deploying your fix" },
      { type: "user", content: "I see no difference" },
      { type: "user", content: "no improvement at all" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 3);
  });

  it("detects 'not working' as rework", () => {
    const session = createSessionFile([
      { type: "user", content: "the timeline is not working correctly" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 1);
  });

  it("does not false-positive 'still' in normal context", () => {
    const session = createSessionFile([
      { type: "user", content: "I still want to add the login feature" },
      { type: "user", content: "we still need to handle edge cases" },
    ]);
    const result = extractConvergence(session, 1);
    assert.equal(result.reworkInstances, 0);
  });
});

describe("outcome deduplication", () => {
  it("deduplicates commits referencing the same issue number", () => {
    const session = createRawSessionFile([
      userMsg("fix the timeline"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): make bars thicker"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): collapse segments"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): rewrite with canvas plugin"' }),
    ]);
    const result = extractConvergence(session, 0);
    // 3 commits to #93 = 1 outcome, not 3
    assert.equal(result.outcomes, 1);
  });

  it("counts commits to different issues as separate outcomes", () => {
    const session = createRawSessionFile([
      userMsg("fix both issues"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): timeline bars"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#94): session ID column"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
  });

  it("counts commits without issue refs individually", () => {
    const session = createRawSessionFile([
      userMsg("make some changes"),
      toolUseMsg("Bash", { command: 'git commit -m "chore: cleanup"' }),
      toolUseMsg("Bash", { command: 'git commit -m "docs: update readme"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.outcomes, 2);
  });

  it("mixes issue-ref dedup with non-ref commits correctly", () => {
    const session = createRawSessionFile([
      userMsg("fix and cleanup"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 1"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 2"' }),
      toolUseMsg("Bash", { command: 'git commit -m "chore: unrelated cleanup"' }),
    ]);
    const result = extractConvergence(session, 0);
    // 1 (deduped #93) + 1 (no-ref commit) = 2
    assert.equal(result.outcomes, 2);
  });

  it("still combines with file edits and PRs", () => {
    const session = createRawSessionFile([
      userMsg("fix and ship"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 1"' }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 2"' }),
      toolUseMsg("Bash", { command: 'gh pr create --title "fix"' }),
    ]);
    const result = extractConvergence(session, 0);
    // 1 file + 1 deduped issue + 1 PR = 3
    assert.equal(result.outcomes, 3);
  });
});
