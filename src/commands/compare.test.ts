import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  compareDateSplit,
  compareCrossProject,
  formatComparison,
  runCompare,
  CompareResult,
} from "./compare.js";

const tmpA = join(tmpdir(), "pulse-compare-a-" + process.pid);
const tmpB = join(tmpdir(), "pulse-compare-b-" + process.pid);

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-03-27T10:00:00.000Z",
    project: "test",
    cwd: "/tmp/test",
    convergence: { exchanges: 5, outcomes: 3, rate: 1.67, reworkInstances: 1, reworkPercent: 20, duplicateCommits: 0, blindRetries: 0, pivot: null },
    intentAnchoring: { intentsPresent: false, claudeMdPresent: false, declaredIntents: [], relevantIntents: [], referencedIntents: [], gap: [], intentLayerCheck: null },
    decisionQuality: { commitsTotal: 3, commitsWithWhy: 1, commitsWithIssueRef: 0, externalContextProvided: false, commitMessages: [] },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensPerExchange: 0, tokensPerOutcome: 0, available: false },
    interactionPattern: { userStyle: "directive", contextProvision: "structured", observation: "" },
    promptEffectiveness: { available: true, events: [], scores: { contextProvision: 0.5, scopeDiscipline: 0.6, feedbackQuality: 0.4, decomposition: 0.7, verification: 0.8 }, overallScore: 0.6, rating: "good", observation: "", coaching: [] },
    interactionLeverage: "MEDIUM",
    leverageScore: 0.55,
    ...overrides,
  };
}

describe("compareDateSplit", () => {
  beforeEach(() => mkdirSync(join(tmpA, ".pulse"), { recursive: true }));
  afterEach(() => rmSync(tmpA, { recursive: true, force: true }));

  it("splits reports at given date and computes deltas", () => {
    const before1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z", convergence: { exchanges: 8, outcomes: 2, rate: 4.0, reworkInstances: 3, reworkPercent: 25, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.35 });
    const before2 = makeReport({ timestamp: "2026-03-12T10:00:00.000Z", convergence: { exchanges: 6, outcomes: 3, rate: 2.0, reworkInstances: 2, reworkPercent: 15, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.45 });
    const after1 = makeReport({ timestamp: "2026-03-16T10:00:00.000Z", convergence: { exchanges: 3, outcomes: 3, rate: 1.0, reworkInstances: 0, reworkPercent: 5, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.72 });
    const after2 = makeReport({ timestamp: "2026-03-18T10:00:00.000Z", convergence: { exchanges: 2, outcomes: 2, rate: 1.0, reworkInstances: 0, reworkPercent: 3, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.80 });

    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(before1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(before2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(after1));
    writeFileSync(join(tmpA, ".pulse", "pulse-4.json"), JSON.stringify(after2));

    const result = compareDateSplit(tmpA, "2026-03-15");
    assert.ok(typeof result !== "string", `expected CompareResult, got: ${result}`);
    assert.equal(result.mode, "date-split");
    assert.equal(result.leftCount, 2);
    assert.equal(result.rightCount, 2);

    const conv = result.metrics.find((m) => m.metric === "Convergence Rate")!;
    assert.equal(conv.left, 3.0); // avg of 4.0 and 2.0
    assert.equal(conv.right, 1.0); // avg of 1.0 and 1.0
    assert.equal(conv.direction, "improved"); // lower is better

    const leverage = result.metrics.find((m) => m.metric === "Leverage Score")!;
    assert.equal(leverage.left, 0.4); // avg of 0.35 and 0.45
    assert.equal(leverage.right, 0.76); // avg of 0.72 and 0.80
    assert.equal(leverage.direction, "improved"); // higher is better
  });

  it("returns error for invalid date", () => {
    const result = compareDateSplit(tmpA, "not-a-date");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Invalid date"));
  });

  it("returns error when no reports exist", () => {
    const empty = join(tmpdir(), "pulse-compare-empty-" + process.pid);
    const result = compareDateSplit(empty, "2026-03-15");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("No pulse reports"));
  });

  it("returns error when fewer than 2 reports before date", () => {
    const r1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-20T10:00:00.000Z" });
    const r3 = makeReport({ timestamp: "2026-03-22T10:00:00.000Z" });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(r3));

    const result = compareDateSplit(tmpA, "2026-03-15");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Need at least 2 reports before"));
  });

  it("returns error when fewer than 2 reports after date", () => {
    const r1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-12T10:00:00.000Z" });
    const r3 = makeReport({ timestamp: "2026-03-20T10:00:00.000Z" });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(r3));

    const result = compareDateSplit(tmpA, "2026-03-15");
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Need at least 2 reports after"));
  });
});

describe("compareCrossProject", () => {
  beforeEach(() => {
    mkdirSync(join(tmpA, ".pulse"), { recursive: true });
    mkdirSync(join(tmpB, ".pulse"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  });

  it("compares two projects", () => {
    const a1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z", convergence: { exchanges: 8, outcomes: 2, rate: 4.0, reworkInstances: 3, reworkPercent: 20, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.35 });
    const a2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z", convergence: { exchanges: 6, outcomes: 3, rate: 3.0, reworkInstances: 2, reworkPercent: 15, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.45 });
    const b1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z", convergence: { exchanges: 3, outcomes: 3, rate: 1.0, reworkInstances: 0, reworkPercent: 5, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.72 });
    const b2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z", convergence: { exchanges: 2, outcomes: 2, rate: 1.0, reworkInstances: 0, reworkPercent: 3, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.80 });

    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(a1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(a2));
    writeFileSync(join(tmpB, ".pulse", "pulse-1.json"), JSON.stringify(b1));
    writeFileSync(join(tmpB, ".pulse", "pulse-2.json"), JSON.stringify(b2));

    const result = compareCrossProject(tmpA, tmpB);
    assert.ok(typeof result !== "string", `expected CompareResult, got: ${result}`);
    assert.equal(result.mode, "cross-project");
    assert.equal(result.leftCount, 2);
    assert.equal(result.rightCount, 2);

    const conv = result.metrics.find((m) => m.metric === "Convergence Rate")!;
    assert.equal(conv.left, 3.5); // avg of 4.0 and 3.0
    assert.equal(conv.right, 1.0);
    assert.equal(conv.direction, "improved");
  });

  it("returns error when project A has too few reports", () => {
    const a1 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    const b1 = makeReport({ timestamp: "2026-03-26T10:00:00.000Z" });
    const b2 = makeReport({ timestamp: "2026-03-27T10:00:00.000Z" });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(a1));
    writeFileSync(join(tmpB, ".pulse", "pulse-1.json"), JSON.stringify(b1));
    writeFileSync(join(tmpB, ".pulse", "pulse-2.json"), JSON.stringify(b2));

    const result = compareCrossProject(tmpA, tmpB);
    assert.ok(typeof result === "string");
    assert.ok(result.includes("Need at least 2 reports"));
  });
});

describe("formatComparison", () => {
  it("formats date-split comparison with direction labels", () => {
    const result: CompareResult = {
      mode: "date-split",
      leftLabel: "before 2026-03-15",
      rightLabel: "after 2026-03-15",
      leftCount: 3,
      rightCount: 4,
      metrics: [
        { metric: "Convergence Rate", left: 3.20, right: 1.80, delta: -1.40, direction: "improved", lowerIsBetter: true },
        { metric: "Rework %", left: 18, right: 8, delta: -10, direction: "improved", lowerIsBetter: true },
        { metric: "Leverage Score", left: 0.45, right: 0.72, delta: 0.27, direction: "improved", lowerIsBetter: false },
        { metric: "Prompt Score", left: 0.55, right: 0.70, delta: 0.15, direction: "improved", lowerIsBetter: false },
      ],
    };

    const output = formatComparison(result);
    assert.ok(output.includes("before 2026-03-15 vs after 2026-03-15"));
    assert.ok(output.includes("Before"));
    assert.ok(output.includes("After"));
    assert.ok(output.includes("Convergence Rate"));
    assert.ok(output.includes("improved"));
    assert.ok(output.includes("3 vs 4"));
  });

  it("formats cross-project comparison with project labels", () => {
    const result: CompareResult = {
      mode: "cross-project",
      leftLabel: "project-a",
      rightLabel: "project-b",
      leftCount: 5,
      rightCount: 5,
      metrics: [
        { metric: "Convergence Rate", left: 2.0, right: 2.1, delta: 0.1, direction: "declined", lowerIsBetter: true },
        { metric: "Rework %", left: 10, right: 10, delta: 0, direction: "stable", lowerIsBetter: true },
        { metric: "Leverage Score", left: 0.60, right: 0.60, delta: 0, direction: "stable", lowerIsBetter: false },
        { metric: "Prompt Score", left: null, right: 0.70, delta: null, direction: "n/a", lowerIsBetter: false },
      ],
    };

    const output = formatComparison(result);
    assert.ok(output.includes("project-a vs project-b"));
    assert.ok(output.includes("project-a"));
    assert.ok(output.includes("project-b"));
    assert.ok(output.includes("stable"));
    assert.ok(output.includes("n/a"));
  });
});

describe("runCompare", () => {
  beforeEach(() => mkdirSync(join(tmpA, ".pulse"), { recursive: true }));
  afterEach(() => rmSync(tmpA, { recursive: true, force: true }));

  it("shows usage when no flags or paths given", () => {
    const output = runCompare([]);
    assert.ok(output.includes("Usage"));
  });

  it("runs date-split mode with --before flag", () => {
    const r1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z", leverageScore: 0.4 });
    const r2 = makeReport({ timestamp: "2026-03-12T10:00:00.000Z", leverageScore: 0.5 });
    const r3 = makeReport({ timestamp: "2026-03-20T10:00:00.000Z", leverageScore: 0.7 });
    const r4 = makeReport({ timestamp: "2026-03-22T10:00:00.000Z", leverageScore: 0.8 });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(r3));
    writeFileSync(join(tmpA, ".pulse", "pulse-4.json"), JSON.stringify(r4));

    const output = runCompare(["--before", "2026-03-15", tmpA]);
    assert.ok(output.includes("Pulse Comparison"));
    assert.ok(output.includes("Convergence Rate"));
  });

  it("outputs JSON with --json flag in date-split mode", () => {
    const r1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z" });
    const r2 = makeReport({ timestamp: "2026-03-12T10:00:00.000Z" });
    const r3 = makeReport({ timestamp: "2026-03-20T10:00:00.000Z" });
    const r4 = makeReport({ timestamp: "2026-03-22T10:00:00.000Z" });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(r3));
    writeFileSync(join(tmpA, ".pulse", "pulse-4.json"), JSON.stringify(r4));

    const output = runCompare(["--before", "2026-03-15", "--json", tmpA]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.mode, "date-split");
    assert.equal(parsed.metrics.length, 4);
    assert.ok(parsed.metrics[0].delta !== undefined);
  });

  it("handles prompt score n/a when unavailable", () => {
    const r1 = makeReport({ timestamp: "2026-03-10T10:00:00.000Z", promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "", coaching: [] } });
    const r2 = makeReport({ timestamp: "2026-03-12T10:00:00.000Z", promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "", coaching: [] } });
    const r3 = makeReport({ timestamp: "2026-03-20T10:00:00.000Z" });
    const r4 = makeReport({ timestamp: "2026-03-22T10:00:00.000Z" });
    writeFileSync(join(tmpA, ".pulse", "pulse-1.json"), JSON.stringify(r1));
    writeFileSync(join(tmpA, ".pulse", "pulse-2.json"), JSON.stringify(r2));
    writeFileSync(join(tmpA, ".pulse", "pulse-3.json"), JSON.stringify(r3));
    writeFileSync(join(tmpA, ".pulse", "pulse-4.json"), JSON.stringify(r4));

    const output = runCompare(["--before", "2026-03-15", "--json", tmpA]);
    const parsed = JSON.parse(output);
    const prompt = parsed.metrics.find((m: { metric: string }) => m.metric === "Prompt Score");
    assert.equal(prompt.left, null);
    assert.equal(prompt.direction, "n/a");
  });
});
