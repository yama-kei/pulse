import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { extractDecisionQuality, scoreCommitMessages } from "./decision-quality.js";

describe("extractDecisionQuality", () => {
  it("returns empty signal for non-git directory", () => {
    const result = extractDecisionQuality("/tmp");
    assert.equal(result.commitsTotal, 0);
    assert.equal(result.commitsWithWhy, 0);
    assert.equal(result.commitsWithIssueRef, 0);
    assert.deepEqual(result.commitMessages, []);
  });
});

describe("scoreCommitMessages", () => {
  it("counts explicit why-language", () => {
    const result = scoreCommitMessages([
      "refactor auth because the old middleware was non-compliant",
      "update readme",
    ]);
    assert.equal(result.commitsWithWhy, 1);
  });

  it("counts conventional commit prefixes as why", () => {
    const result = scoreCommitMessages([
      "feat: add login form",
      "fix: prevent null pointer in auth",
      "refactor: extract validation logic",
      "docs: update API reference",
      "test: add coverage for edge cases",
      "chore: bump dependencies",
    ]);
    assert.equal(result.commitsWithWhy, 6);
  });

  it("counts issue references as why", () => {
    const result = scoreCommitMessages([
      "update auth handling (#42)",
      "improve performance for #15",
    ]);
    assert.equal(result.commitsWithWhy, 2);
  });

  it("does not double-count commits matching multiple signals", () => {
    const result = scoreCommitMessages([
      "fix: resolve null pointer because of missing check (#42)",
    ]);
    // One commit, should count as 1
    assert.equal(result.commitsTotal, 1);
    assert.equal(result.commitsWithWhy, 1);
  });

  it("does not count bare messages without why signals", () => {
    const result = scoreCommitMessages([
      "update stuff",
      "changes",
      "wip",
    ]);
    assert.equal(result.commitsWithWhy, 0);
  });

  it("still tracks issue refs separately", () => {
    const result = scoreCommitMessages([
      "feat: add login (#10)",
      "fix something because reasons",
      "update readme",
    ]);
    assert.equal(result.commitsWithIssueRef, 1);
    assert.equal(result.commitsWithWhy, 2); // feat: and because
  });
});
