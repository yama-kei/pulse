import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractTokenUsage } from "./token-usage.js";
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
    withTmpSession(
      [
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
      ],
      (file) => {
        const result = extractTokenUsage(file, 2, 4);
        assert.equal(result.available, true);
        assert.equal(result.inputTokens, 1500);
        assert.equal(result.outputTokens, 300);
        assert.equal(result.totalTokens, 1800);
        assert.equal(result.tokensPerExchange, 900);
        assert.equal(result.tokensPerOutcome, 450);
      }
    );
  });

  it("skips non-assistant messages", () => {
    withTmpSession(
      [
        JSON.stringify({ message: { role: "user", content: "hi" } }),
        JSON.stringify({
          message: {
            role: "assistant",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ],
      (file) => {
        const result = extractTokenUsage(file, 1, 1);
        assert.equal(result.inputTokens, 100);
        assert.equal(result.outputTokens, 50);
      }
    );
  });

  it("handles zero exchanges gracefully", () => {
    withTmpSession(
      [
        JSON.stringify({
          message: {
            role: "assistant",
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        }),
      ],
      (file) => {
        const result = extractTokenUsage(file, 0, 1);
        assert.equal(result.available, true);
        assert.equal(result.tokensPerExchange, 0);
        assert.equal(result.tokensPerOutcome, 150);
      }
    );
  });

  it("skips malformed JSON lines gracefully", () => {
    withTmpSession(
      [
        "not valid json",
        JSON.stringify({
          message: {
            role: "assistant",
            usage: { input_tokens: 200, output_tokens: 80 },
          },
        }),
        "{truncated",
      ],
      (file) => {
        const result = extractTokenUsage(file, 1, 1);
        assert.equal(result.available, true);
        assert.equal(result.inputTokens, 200);
        assert.equal(result.outputTokens, 80);
        assert.equal(result.totalTokens, 280);
      }
    );
  });
});
