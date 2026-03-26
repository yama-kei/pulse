import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractIntentAnchoring } from "./intent-anchoring.js";

describe("extractIntentAnchoring", () => {
  it("reports absent when no INTENTS.md or CLAUDE.md", () => {
    const result = extractIntentAnchoring("/tmp", []);
    assert.equal(result.intentsPresent, false);
    assert.equal(result.claudeMdPresent, false);
    assert.deepEqual(result.declaredIntents, []);
    assert.deepEqual(result.gap, []);
  });
});
