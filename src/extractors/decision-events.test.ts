import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractDecisionEvents } from "./decision-events.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withTmpSession(lines: string[], fn: (file: string) => void) {
  const tmp = mkdtempSync(join(tmpdir(), "pulse-test-"));
  const file = join(tmp, "session.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  try {
    fn(file);
  } finally {
    rmSync(tmp, { recursive: true });
  }
}

function assistantWithTools(tools: Array<{ name: string; input: Record<string, unknown> }>, timestamp: string, tokens = 1000) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: tools.map(t => ({ type: "tool_use", name: t.name, input: t.input })),
      usage: { input_tokens: tokens, output_tokens: tokens / 2 },
    },
  });
}

function userMessage(text: string, timestamp: string) {
  return JSON.stringify({
    type: "user",
    timestamp,
    message: { role: "user", content: text },
  });
}

describe("extractDecisionEvents", () => {
  it("returns unavailable signal with no session file", () => {
    const result = extractDecisionEvents(null, 0);
    assert.equal(result.available, false);
    assert.equal(result.decisionCount, 0);
    assert.equal(result.tokensPerDecision, 0);
  });

  it("returns unavailable signal for nonexistent file", () => {
    const result = extractDecisionEvents("/tmp/nonexistent.jsonl", 0);
    assert.equal(result.available, false);
  });

  it("detects implementation_decided from edit → commit", () => {
    withTmpSession([
      userMessage("add a login form", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add login form"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      assert.equal(result.available, true);
      assert.equal(result.decisionCount, 1);
      assert.equal(result.events[0].type, "implementation_decided");
      assert.equal(result.events[0].confidence, "high");
      assert.deepEqual(result.events[0].relatedFiles, ["src/auth.ts"]);
    });
  });

  it("detects feature_shipped from feat: commit + PR", () => {
    withTmpSession([
      userMessage("ship the feature", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/feature.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: new feature"' } },
        { name: "Bash", input: { command: 'gh pr create --title "feat" --body "done"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      const shipped = result.events.find(e => e.type === "feature_shipped");
      assert.ok(shipped, "should detect feature_shipped");
      assert.equal(shipped!.confidence, "high");
    });
  });

  it("detects bug_resolved from fix: commit + issue ref", () => {
    withTmpSession([
      userMessage("fix the auth bug", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "fix: resolve auth crash (#42)"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      const resolved = result.events.find(e => e.type === "bug_resolved");
      assert.ok(resolved, "should detect bug_resolved");
      assert.equal(resolved!.confidence, "high");
    });
  });

  it("detects root_cause_identified from exploration → fix: commit", () => {
    withTmpSession([
      userMessage("figure out why auth fails", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Read", input: { file_path: "src/auth.ts" } },
        { name: "Grep", input: { pattern: "error", path: "src/" } },
        { name: "Read", input: { file_path: "src/middleware.ts" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/auth.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:02:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "fix: correct token validation"' } },
      ], "2026-04-02T10:03:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 6000);
      const rootCause = result.events.find(e => e.type === "root_cause_identified");
      assert.ok(rootCause, "should detect root_cause_identified");
    });
  });

  it("detects schema_locked for files edited early and untouched later", () => {
    withTmpSession([
      userMessage("set up types", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Write", input: { file_path: "src/types.ts" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add types"' } },
      ], "2026-04-02T10:02:00Z"),
      // Second half of session works on different files
      userMessage("now implement the handler", "2026-04-02T10:03:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/handler.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:04:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: add handler"' } },
      ], "2026-04-02T10:05:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 6000);
      const locked = result.events.find(e => e.type === "schema_locked");
      assert.ok(locked, "should detect schema_locked for types.ts");
      assert.equal(locked!.confidence, "medium");
      assert.deepEqual(locked!.relatedFiles, ["src/types.ts"]);
    });
  });

  it("computes tokensPerDecision correctly", () => {
    withTmpSession([
      userMessage("do work", "2026-04-02T10:00:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: first"' } },
      ], "2026-04-02T10:02:00Z"),
      userMessage("more work", "2026-04-02T10:03:00Z"),
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/b.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:04:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: second"' } },
      ], "2026-04-02T10:05:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 10000);
      assert.equal(result.decisionCount, 2);
      assert.equal(result.tokensPerDecision, 5000);
    });
  });

  it("returns empty events for session with no tool use", () => {
    withTmpSession([
      userMessage("hello", "2026-04-02T10:00:00Z"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-02T10:01:00Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      }),
    ], (file) => {
      const result = extractDecisionEvents(file, 1000);
      assert.equal(result.available, false);
      assert.equal(result.decisionCount, 0);
    });
  });

  it("handles malformed JSON lines gracefully", () => {
    withTmpSession([
      "not valid json",
      userMessage("do work", "2026-04-02T10:00:00Z"),
      "{truncated",
      assistantWithTools([
        { name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
      ], "2026-04-02T10:01:00Z"),
      assistantWithTools([
        { name: "Bash", input: { command: 'git commit -m "feat: something"' } },
      ], "2026-04-02T10:02:00Z"),
    ], (file) => {
      const result = extractDecisionEvents(file, 3000);
      assert.equal(result.available, true);
      assert.ok(result.decisionCount >= 1, "should detect at least one event despite malformed lines");
    });
  });
});
