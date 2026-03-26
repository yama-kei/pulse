import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractConvergence } from "./convergence.js";

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
});
