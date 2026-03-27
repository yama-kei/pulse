import { chatCompletion, LlmUnavailableError } from "./llm-client.js";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

describe("llm-client", () => {
  it("throws LlmUnavailableError when OPENAI_API_KEY is not set", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await assert.rejects(
        () => chatCompletion("gpt-4o", [{ role: "user", content: "hello" }]),
        (err: Error) => {
          assert.ok(err instanceof LlmUnavailableError);
          return true;
        }
      );
    } finally {
      if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    }
  });
});
