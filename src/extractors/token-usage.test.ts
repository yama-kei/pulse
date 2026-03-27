import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractTokenUsage } from "./token-usage.js";
import { writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("extractTokenUsage", () => {
  it("returns unavailable signal with no session file", () => {
    const result = extractTokenUsage(null, 5, 3);
    assert.equal(result.available, false);
    assert.equal(result.totalTokens, 0);
  });

  it("returns unavailable signal when file does not exist", () => {
    const result = extractTokenUsage("/tmp/nonexistent.jsonl", 5, 3);
    assert.equal(result.available, false);
  });

  it("sums token usage from assistant messages", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pulse-test-"));
    const file = join(tmp, "session.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input_tokens: 1000, output_tokens: 200 },
        },
      }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const result = extractTokenUsage(file, 2, 4);
    assert.equal(result.available, true);
    assert.equal(result.inputTokens, 1500);
    assert.equal(result.outputTokens, 300);
    assert.equal(result.totalTokens, 1800);
    assert.equal(result.tokensPerExchange, 900);
    assert.equal(result.tokensPerOutcome, 450);

    unlinkSync(file);
  });

  it("skips non-assistant messages", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pulse-test-"));
    const file = join(tmp, "session.jsonl");
    const lines = [
      JSON.stringify({ message: { role: "user", content: "hi" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const result = extractTokenUsage(file, 1, 1);
    assert.equal(result.inputTokens, 100);
    assert.equal(result.outputTokens, 50);

    unlinkSync(file);
  });

  it("handles zero exchanges gracefully", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pulse-test-"));
    const file = join(tmp, "session.jsonl");
    const lines = [
      JSON.stringify({
        message: {
          role: "assistant",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    const result = extractTokenUsage(file, 0, 1);
    assert.equal(result.available, true);
    assert.equal(result.tokensPerExchange, 0);
    assert.equal(result.tokensPerOutcome, 150);

    unlinkSync(file);
  });
});
