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
});
