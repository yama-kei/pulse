import {
  scoreEvents,
  rateOverall,
  extractPromptEffectiveness,
} from "./prompt-effectiveness.js";
import { PromptEvent, EffectivenessScores } from "../types/pulse.js";
import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createSessionFile(
  messages: Array<{ type: string; content: string }>
): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-pe-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  const lines = messages.map((m) =>
    JSON.stringify({
      type: m.type,
      message: {
        role: m.type === "user" ? "user" : "assistant",
        content: m.content,
      },
    })
  );
  writeFileSync(filePath, lines.join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { unlinkSync(f); } catch {}
  }
  for (const d of tmpDirs) {
    try { rmdirSync(d); } catch {}
  }
  tmpFiles = [];
  tmpDirs = [];
});

describe("prompt-effectiveness scoring (stage 2)", () => {
  it("scores high for well-structured prompts", () => {
    const events: PromptEvent[] = [
      { messageIndex: 0, eventType: "PROVIDED_CONTEXT", reasoning: "shared file paths" },
      { messageIndex: 0, eventType: "SCOPED_REQUEST", reasoning: "clear bounded task" },
      { messageIndex: 1, eventType: "PROVIDED_CONTEXT", reasoning: "included code block" },
      { messageIndex: 1, eventType: "DECOMPOSED_TASK", reasoning: "broke into 3 steps" },
      { messageIndex: 2, eventType: "GAVE_ACTIONABLE_FEEDBACK", reasoning: "specific fix" },
    ];
    const scores = scoreEvents(events, 3);
    assert.ok(scores.contextProvision > 0.5, `contextProvision should be > 0.5, got ${scores.contextProvision}`);
    assert.ok(scores.scopeDiscipline > 0.5, `scopeDiscipline should be > 0.5, got ${scores.scopeDiscipline}`);
    assert.ok(scores.feedbackQuality > 0.5, `feedbackQuality should be > 0.5, got ${scores.feedbackQuality}`);
    assert.ok(scores.decomposition > 0.5, `decomposition should be > 0.5, got ${scores.decomposition}`);
  });

  it("scores low for vague undirected prompts", () => {
    const events: PromptEvent[] = [
      { messageIndex: 0, eventType: "VAGUE_REQUEST", reasoning: "no specifics" },
      { messageIndex: 1, eventType: "GAVE_VAGUE_FEEDBACK", reasoning: "just said 'wrong'" },
      { messageIndex: 1, eventType: "ACCEPTED_WITHOUT_REVIEW", reasoning: "no check" },
      { messageIndex: 2, eventType: "VAGUE_REQUEST", reasoning: "unclear intent" },
      { messageIndex: 2, eventType: "ACCEPTED_WITHOUT_REVIEW", reasoning: "no check" },
      { messageIndex: 3, eventType: "ACCEPTED_WITHOUT_REVIEW", reasoning: "no check" },
      { messageIndex: 4, eventType: "SCOPE_CREPT", reasoning: "added unrelated work" },
    ];
    const scores = scoreEvents(events, 5);
    assert.ok(scores.scopeDiscipline < 0.5, `scopeDiscipline should be < 0.5, got ${scores.scopeDiscipline}`);
    assert.ok(scores.feedbackQuality < 0.5, `feedbackQuality should be < 0.5, got ${scores.feedbackQuality}`);
    assert.ok(scores.verification < 0.5, `verification should be < 0.5, got ${scores.verification}`);
  });

  it("handles zero messages gracefully", () => {
    const scores = scoreEvents([], 0);
    assert.equal(scores.contextProvision, 0);
    assert.equal(scores.scopeDiscipline, 0);
    assert.equal(scores.feedbackQuality, 0);
    assert.equal(scores.decomposition, 0);
    assert.equal(scores.verification, 1);
  });

  it("rates overall score correctly", () => {
    assert.equal(rateOverall(0.85), "excellent");
    assert.equal(rateOverall(0.65), "good");
    assert.equal(rateOverall(0.45), "moderate");
    assert.equal(rateOverall(0.2), "developing");
  });

  it("returns unavailable signal when no session file", async () => {
    const result = await extractPromptEffectiveness(null);
    assert.equal(result.available, false);
    assert.deepEqual(result.events, []);
    assert.equal(result.overallScore, 0);
  });

  it("returns unavailable signal when OPENAI_API_KEY not set", async () => {
    const session = createSessionFile([
      { type: "user", content: "fix the bug" },
      { type: "assistant", content: "done" },
    ]);
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await extractPromptEffectiveness(session);
      assert.equal(result.available, false);
    } finally {
      if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
