import {
  scoreEvents,
  rateOverall,
  extractPromptEffectiveness,
} from "./prompt-effectiveness.js";
import { PromptEvent } from "../types/pulse.js";
import { strict as assert } from "node:assert";
import { describe, it, afterEach, mock } from "node:test";
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

  it("produces scored signal from mocked LLM response", async () => {
    const session = createSessionFile([
      { type: "user", content: "Here is src/app.ts — it has a null pointer on line 42. Please fix the null check." },
      { type: "assistant", content: "I see the issue..." },
      { type: "user", content: "Also add a test for that fix in app.test.ts" },
      { type: "assistant", content: "Done" },
      { type: "user", content: "The test is missing the edge case where input is undefined. Add that assertion." },
    ]);

    const mockResponse = JSON.stringify({
      events: [
        { messageIndex: 0, eventType: "PROVIDED_CONTEXT", reasoning: "shared file and line" },
        { messageIndex: 0, eventType: "SCOPED_REQUEST", reasoning: "specific fix request" },
        { messageIndex: 1, eventType: "SCOPED_REQUEST", reasoning: "bounded follow-up" },
        { messageIndex: 2, eventType: "GAVE_ACTIONABLE_FEEDBACK", reasoning: "specific missing case" },
      ],
    });

    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: mockResponse } }],
      }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await extractPromptEffectiveness(session);

      assert.equal(result.available, true);
      assert.equal(result.events.length, 4);
      assert.ok(result.overallScore > 0, `overallScore should be > 0, got ${result.overallScore}`);
      assert.ok(result.scores.contextProvision > 0, `contextProvision should be > 0`);
      assert.equal(result.scores.scopeDiscipline, 1); // 2 scoped, 0 vague
      assert.equal(result.scores.feedbackQuality, 1); // 1 actionable, 0 vague
      assert.ok(["excellent", "good", "moderate", "developing"].includes(result.rating));
      assert.ok(result.observation.includes("3 messages analyzed"));

      // Verify fetch was called with correct model and auth
      assert.equal(mockFetch.mock.callCount(), 1);
      const [url, opts] = mockFetch.mock.calls[0].arguments as unknown as [string, any];
      assert.ok(url.includes("/chat/completions"));
      assert.equal(opts.headers.Authorization, "Bearer test-key");
      const body = JSON.parse(opts.body);
      assert.equal(body.model, "gpt-4o");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey !== undefined) {
        process.env.OPENAI_API_KEY = originalKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
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
