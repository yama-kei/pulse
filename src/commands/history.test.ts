import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadReports } from "./history.js";

const tmp = join(tmpdir(), "pulse-history-test-" + process.pid);

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-03-27T10:00:00.000Z",
    project: "test",
    cwd: "/tmp/test",
    convergence: { exchanges: 5, outcomes: 3, rate: 1.67, reworkInstances: 1, reworkPercent: 20 },
    intentAnchoring: { intentsPresent: false, claudeMdPresent: false, declaredIntents: [], relevantIntents: [], referencedIntents: [], gap: [], intentLayerCheck: null },
    decisionQuality: { commitsTotal: 3, commitsWithWhy: 1, commitsWithIssueRef: 0, externalContextProvided: false, commitMessages: [] },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensPerExchange: 0, tokensPerOutcome: 0, available: false },
    interactionPattern: { userStyle: "directive", contextProvision: "structured", observation: "" },
    promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "" },
    interactionLeverage: "MEDIUM",
    ...overrides,
  };
}

describe("loadReports", () => {
  beforeEach(() => mkdirSync(join(tmp, ".pulse"), { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns empty array when .pulse/ does not exist", () => {
    const noPulseDir = join(tmpdir(), "pulse-no-exist-" + process.pid);
    const result = loadReports(noPulseDir);
    assert.deepStrictEqual(result, []);
  });

  it("reads and parses pulse-*.json files", () => {
    const report = makeReport();
    writeFileSync(join(tmp, ".pulse", "pulse-2026-03-27T10-00-00-000Z.json"), JSON.stringify(report));
    const result = loadReports(tmp);
    assert.equal(result.length, 1);
    assert.equal(result[0].timestamp, "2026-03-27T10:00:00.000Z");
  });

  it("ignores non-pulse JSON files", () => {
    writeFileSync(join(tmp, ".pulse", "other.json"), "{}");
    const report = makeReport();
    writeFileSync(join(tmp, ".pulse", "pulse-2026-03-27T10-00-00-000Z.json"), JSON.stringify(report));
    const result = loadReports(tmp);
    assert.equal(result.length, 1);
  });

  it("skips malformed JSON files gracefully", () => {
    writeFileSync(join(tmp, ".pulse", "pulse-bad.json"), "not json");
    const report = makeReport();
    writeFileSync(join(tmp, ".pulse", "pulse-2026-03-27T10-00-00-000Z.json"), JSON.stringify(report));
    const result = loadReports(tmp);
    assert.equal(result.length, 1);
  });

  it("sorts by date descending", () => {
    const r1 = makeReport({ timestamp: "2026-03-25T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    const r3 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmp, ".pulse", "pulse-3.json"), JSON.stringify(r3));
    const result = loadReports(tmp);
    assert.equal(result[0].timestamp, "2026-03-27T10:00:00.000Z");
    assert.equal(result[1].timestamp, "2026-03-26T10:00:00.000Z");
    assert.equal(result[2].timestamp, "2026-03-25T10:00:00.000Z");
  });
});
