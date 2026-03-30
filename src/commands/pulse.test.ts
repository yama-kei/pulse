import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHistoricalScores, formatDelta, runPulse } from "./pulse.js";

const tmp = join(tmpdir(), "pulse-coaching-test-" + process.pid);

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
    promptEffectiveness: {
      available: true,
      events: [],
      scores: { contextProvision: 0.5, scopeDiscipline: 0.6, feedbackQuality: 0.4, decomposition: 0.7, verification: 0.8 },
      overallScore: 0.6,
      rating: "good",
      observation: "test",
      coaching: [],
    },
    interactionLeverage: "MEDIUM",
    ...overrides,
  };
}

describe("loadHistoricalScores", () => {
  beforeEach(() => mkdirSync(join(tmp, ".pulse"), { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns null when fewer than 2 prior reports", () => {
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    const result = loadHistoricalScores(tmp, "2026-03-27T10:00:00.000Z");
    assert.equal(result, null);
  });

  it("returns null when no .pulse/ directory", () => {
    const noDir = join(tmpdir(), "pulse-no-exist-" + process.pid);
    const result = loadHistoricalScores(noDir, "2026-03-27T10:00:00.000Z");
    assert.equal(result, null);
  });

  it("computes average scores from prior reports", () => {
    const r1 = makeReport({
      timestamp: "2026-03-25T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.4, scopeDiscipline: 0.6, feedbackQuality: 0.2, decomposition: 0.5, verification: 0.8 },
        overallScore: 0.5, rating: "good", observation: "",
      },
    });
    const r2 = makeReport({
      timestamp: "2026-03-26T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.6, scopeDiscipline: 0.8, feedbackQuality: 0.4, decomposition: 0.7, verification: 0.6 },
        overallScore: 0.7, rating: "good", observation: "",
      },
    });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));

    const result = loadHistoricalScores(tmp, "2026-03-27T10:00:00.000Z");
    assert.ok(result);
    assert.equal(result.count, 2);
    assert.equal(result.avgScores["contextProvision"], 0.5);
    assert.equal(result.avgScores["scopeDiscipline"], 0.7);
  });

  it("excludes current report by timestamp", () => {
    const r1 = makeReport({
      timestamp: "2026-03-25T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.4, scopeDiscipline: 0.6, feedbackQuality: 0.2, decomposition: 0.5, verification: 0.8 },
        overallScore: 0.5, rating: "good", observation: "",
      },
    });
    const r2 = makeReport({
      timestamp: "2026-03-26T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.6, scopeDiscipline: 0.8, feedbackQuality: 0.4, decomposition: 0.7, verification: 0.6 },
        overallScore: 0.7, rating: "good", observation: "",
      },
    });
    const current = makeReport({
      timestamp: "2026-03-27T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.9, scopeDiscipline: 0.9, feedbackQuality: 0.9, decomposition: 0.9, verification: 0.9 },
        overallScore: 0.9, rating: "excellent", observation: "",
      },
    });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmp, ".pulse", "pulse-3.json"), JSON.stringify(current));

    const result = loadHistoricalScores(tmp, "2026-03-27T10:00:00.000Z");
    assert.ok(result);
    assert.equal(result.count, 2);
    // Average should only include r1 and r2, not the current report
    assert.equal(result.avgScores["contextProvision"], 0.5);
  });

  it("computes overall trend direction", () => {
    const r1 = makeReport({
      timestamp: "2026-03-25T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.3, scopeDiscipline: 0.4, feedbackQuality: 0.2, decomposition: 0.3, verification: 0.5 },
        overallScore: 0.3, rating: "developing", observation: "",
      },
    });
    const r2 = makeReport({
      timestamp: "2026-03-26T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.7, scopeDiscipline: 0.8, feedbackQuality: 0.6, decomposition: 0.7, verification: 0.9 },
        overallScore: 0.8, rating: "excellent", observation: "",
      },
    });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));

    const result = loadHistoricalScores(tmp, "2026-03-27T10:00:00.000Z");
    assert.ok(result);
    assert.equal(result.firstOverall, 0.3);
    assert.ok(result.overallTrend > 0); // improving
  });

  it("skips reports where prompt effectiveness is unavailable", () => {
    const r1 = makeReport({
      timestamp: "2026-03-24T10:00:00.000Z",
      promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "", coaching: [] },
    });
    const r2 = makeReport({
      timestamp: "2026-03-25T10:00:00.000Z",
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.5, scopeDiscipline: 0.6, feedbackQuality: 0.4, decomposition: 0.7, verification: 0.8 },
        overallScore: 0.6, rating: "good", observation: "",
      },
    });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));

    // Only 1 available prior report → null
    const result = loadHistoricalScores(tmp, "2026-03-27T10:00:00.000Z");
    assert.equal(result, null);
  });
});

describe("formatDelta", () => {
  it("shows positive delta with up arrow", () => {
    const result = formatDelta(0.7, 0.5);
    assert.ok(result.includes("↑"));
    assert.ok(result.includes("+0.20"));
    assert.ok(result.includes("vs avg"));
  });

  it("shows negative delta with down arrow", () => {
    const result = formatDelta(0.3, 0.5);
    assert.ok(result.includes("↓"));
    assert.ok(result.includes("-0.20"));
  });

  it("returns empty string for negligible difference", () => {
    const result = formatDelta(0.5, 0.5);
    assert.equal(result, "");
  });

  it("returns empty string for very small difference", () => {
    const result = formatDelta(0.505, 0.5);
    assert.equal(result, "");
  });
});

describe("runPulse with --session path", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pulse-session-flag-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses provided session file instead of auto-discovery", async () => {
    const sessionFile = join(tmpDir, "test-session.jsonl");
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "add a button" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/a.ts" } }],
          },
        }),
      ].join("\n") + "\n"
    );

    const report = await runPulse(tmpDir, sessionFile);
    assert.equal(report.convergence.exchanges, 1);
    assert.equal(report.convergence.outcomes >= 1, true);
  });

  it("falls back to auto-discovery when no session path given", async () => {
    // No session file will be found for tmpDir, so convergence should have 0 exchanges
    const report = await runPulse(tmpDir);
    assert.equal(report.convergence.exchanges, 0);
  });
});
