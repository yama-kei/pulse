import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractDecisionQuality } from "./decision-quality.js";

describe("extractDecisionQuality", () => {
  it("returns empty signal for non-git directory", () => {
    const result = extractDecisionQuality("/tmp");
    assert.equal(result.commitsTotal, 0);
    assert.equal(result.commitsWithWhy, 0);
    assert.equal(result.commitsWithIssueRef, 0);
    assert.deepEqual(result.commitMessages, []);
  });
});
