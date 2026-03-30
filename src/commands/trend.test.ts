import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sparkline, extractTrends, formatTrend, runTrend } from "./trend.js";
import { PulseReport } from "../types/pulse.js";

const tmp = join(tmpdir(), "pulse-trend-test-" + process.pid);

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
    leverageScore: 0.55,
    ...overrides,
  };
}

describe("sparkline", () => {
  it("renders ascending values", () => {
    const result = sparkline([1, 2, 3, 4, 5]);
    assert.equal(result, "▁▃▅▆█");
  });

  it("renders constant values", () => {
    const result = sparkline([5, 5, 5]);
    assert.equal(result, "▅▅▅");
  });

  it("handles null values as spaces", () => {
    const result = sparkline([1, null, 5]);
    assert.equal(result, "▁ █");
  });

  it("inverts when requested", () => {
    const result = sparkline([1, 5], true);
    // 1 is low value → should be high bar when inverted (lower is better = tall bar)
    // 5 is high value → should be low bar when inverted
    assert.equal(result, "█▁");
  });

  it("returns empty string for all nulls", () => {
    assert.equal(sparkline([null, null]), "");
  });
});

describe("extractTrends", () => {
  it("extracts all four metric trends", () => {
    const reports = [
      makeReport({ timestamp: "2026-03-27T10:00:00.000Z", convergence: { exchanges: 5, outcomes: 3, rate: 2.0, reworkInstances: 1, reworkPercent: 10 }, interactionLeverage: "MEDIUM", leverageScore: 0.55 }),
      makeReport({ timestamp: "2026-03-26T10:00:00.000Z", convergence: { exchanges: 3, outcomes: 3, rate: 1.0, reworkInstances: 0, reworkPercent: 5 }, interactionLeverage: "HIGH", leverageScore: 0.82 }),
    ] as unknown as PulseReport[];

    const trends = extractTrends(reports);
    assert.equal(trends.length, 4);
    assert.equal(trends[0].metric, "convergence");
    assert.equal(trends[1].metric, "prompt");
    assert.equal(trends[2].metric, "rework");
    assert.equal(trends[3].metric, "leverage");
  });

  it("reverses reports to chronological order", () => {
    const reports = [
      makeReport({ timestamp: "2026-03-27T10:00:00.000Z", convergence: { exchanges: 5, outcomes: 3, rate: 2.0, reworkInstances: 1, reworkPercent: 10 } }),
      makeReport({ timestamp: "2026-03-25T10:00:00.000Z", convergence: { exchanges: 3, outcomes: 3, rate: 4.0, reworkInstances: 0, reworkPercent: 5 } }),
    ] as unknown as PulseReport[];

    const trends = extractTrends(reports);
    const conv = trends[0];
    // Oldest first: rate 4.0 then 2.0
    assert.equal(conv.values[0].value, 4.0);
    assert.equal(conv.values[1].value, 2.0);
    assert.equal(conv.current, 2.0);
    assert.equal(conv.direction, "improving"); // lower is better, went from 4 to 2
  });

  it("handles null prompt scores", () => {
    const reports = [
      makeReport({ timestamp: "2026-03-27T10:00:00.000Z" }),
      makeReport({ timestamp: "2026-03-26T10:00:00.000Z" }),
    ] as unknown as PulseReport[];

    const trends = extractTrends(reports);
    const prompt = trends[1];
    assert.equal(prompt.current, null);
    assert.equal(prompt.direction, "unknown");
  });
});

describe("formatTrend", () => {
  it("includes header with report count and range", () => {
    const trends = extractTrends([
      makeReport({ timestamp: "2026-03-27T10:00:00.000Z" }),
      makeReport({ timestamp: "2026-03-26T10:00:00.000Z" }),
    ] as unknown as PulseReport[]);

    const output = formatTrend(trends, 2, "last 7d");
    assert.ok(output.includes("Pulse Trends"));
    assert.ok(output.includes("2 reports"));
    assert.ok(output.includes("last 7d"));
  });

  it("shows metric labels and hints", () => {
    const trends = extractTrends([
      makeReport({ timestamp: "2026-03-27T10:00:00.000Z" }),
      makeReport({ timestamp: "2026-03-26T10:00:00.000Z" }),
    ] as unknown as PulseReport[]);

    const output = formatTrend(trends, 2, "all time");
    assert.ok(output.includes("Convergence Rate"));
    assert.ok(output.includes("lower is better"));
    assert.ok(output.includes("Rework %"));
    assert.ok(output.includes("Leverage"));
  });
});

describe("runTrend", () => {
  beforeEach(() => mkdirSync(join(tmp, ".pulse"), { recursive: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("returns message when fewer than 2 reports", () => {
    const output = runTrend(tmp, {});
    assert.ok(output.includes("Need at least 2 pulse reports"));
  });

  it("returns message with 1 report", () => {
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(makeReport()));
    const output = runTrend(tmp, {});
    assert.ok(output.includes("Need at least 2 pulse reports"));
  });

  it("shows trends with 2+ reports", () => {
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    const output = runTrend(tmp, {});
    assert.ok(output.includes("Pulse Trends"));
    assert.ok(output.includes("Convergence Rate"));
  });

  it("outputs JSON with --json flag", () => {
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    const output = runTrend(tmp, { json: true });
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].metric, "convergence");
  });

  it("filters by range", () => {
    const old = makeReport({ timestamp: "2026-01-01T10:00:00.000Z" });
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-old.json"), JSON.stringify(old));
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    const output = runTrend(tmp, { range: "7d" });
    assert.ok(output.includes("last 7d"));
    assert.ok(output.includes("2 reports"));
  });

  it("filters by metric", () => {
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    const output = runTrend(tmp, { metric: "convergence" });
    assert.ok(output.includes("Convergence Rate"));
    assert.ok(!output.includes("Rework"));
  });

  it("returns error for unknown metric", () => {
    const r1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmp, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    const output = runTrend(tmp, { metric: "bogus" });
    assert.ok(output.includes("Unknown metric"));
  });

  it("returns range-specific message when filtered to < 2 reports", () => {
    const old1 = makeReport({ timestamp: "2026-01-01T10:00:00.000Z" });
    const old2 = makeReport({ timestamp: "2026-01-02T10:00:00.000Z" });
    const r1 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmp, ".pulse", "pulse-old1.json"), JSON.stringify(old1));
    writeFileSync(join(tmp, ".pulse", "pulse-old2.json"), JSON.stringify(old2));
    writeFileSync(join(tmp, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    const output = runTrend(tmp, { range: "1d" });
    assert.ok(output.includes("Need at least 2 pulse reports in the last 1d"));
  });
});
