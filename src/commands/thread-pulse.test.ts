import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { aggregateReports, formatThreadReport } from "./pulse.js";
import { PulseReport, ThreadPulseReport } from "../types/pulse.js";

function makeReport(overrides: Record<string, unknown> = {}): PulseReport {
  return {
    timestamp: "2026-03-27T10:00:00.000Z",
    project: "test",
    cwd: "/tmp/test",
    convergence: { exchanges: 5, outcomes: 3, rate: 1.67, reworkInstances: 1, reworkPercent: 20, duplicateCommits: 0, blindRetries: 0, pivot: null },
    intentAnchoring: { intentsPresent: false, claudeMdPresent: false, declaredIntents: [], relevantIntents: [], referencedIntents: [], gap: [], intentLayerCheck: null },
    decisionQuality: { commitsTotal: 3, commitsWithWhy: 1, commitsWithIssueRef: 1, externalContextProvided: false, commitMessages: ["fix: resolve auth bug (#12)", "feat: add login", "chore: deps"] },
    tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, tokensPerExchange: 300, tokensPerOutcome: 500, available: true },
    interactionPattern: { userStyle: "directive", contextProvision: "structured", observation: "test" },
    promptEffectiveness: {
      available: true,
      events: [],
      scores: { contextProvision: 0.6, scopeDiscipline: 0.7, feedbackQuality: 0.5, decomposition: 0.8, verification: 0.9 },
      overallScore: 0.7,
      rating: "good",
      observation: "solid",
      coaching: [],
    },
    interactionLeverage: "MEDIUM",
    leverageScore: 0.55,
    ...overrides,
  } as unknown as PulseReport;
}

describe("aggregateReports", () => {
  it("sums convergence metrics across sessions", () => {
    const r1 = makeReport({ convergence: { exchanges: 4, outcomes: 2, rate: 2.0, reworkInstances: 1, reworkPercent: 25, duplicateCommits: 0, blindRetries: 0, pivot: null } });
    const r2 = makeReport({ convergence: { exchanges: 6, outcomes: 3, rate: 2.0, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 1, blindRetries: 0, pivot: null } });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.convergence.exchanges, 10);
    assert.equal(agg.convergence.outcomes, 5);
    assert.equal(agg.convergence.rate, 2.0);
    assert.equal(agg.convergence.reworkInstances, 1);
    assert.equal(agg.convergence.reworkPercent, 10);
    assert.equal(agg.convergence.duplicateCommits, 1);
  });

  it("sums token usage and recalculates ratios", () => {
    const r1 = makeReport({ tokenUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, tokensPerExchange: 0, tokensPerOutcome: 0, available: true } });
    const r2 = makeReport({ tokenUsage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, tokensPerExchange: 0, tokensPerOutcome: 0, available: true } });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.tokenUsage.inputTokens, 3000);
    assert.equal(agg.tokenUsage.outputTokens, 1500);
    assert.equal(agg.tokenUsage.totalTokens, 4500);
    assert.equal(agg.tokenUsage.available, true);
  });

  it("deduplicates commit messages across sessions", () => {
    const shared = ["fix: resolve auth bug (#12)", "feat: add login"];
    const r1 = makeReport({ decisionQuality: { commitsTotal: 2, commitsWithWhy: 1, commitsWithIssueRef: 1, externalContextProvided: false, commitMessages: shared } });
    const r2 = makeReport({ decisionQuality: { commitsTotal: 3, commitsWithWhy: 1, commitsWithIssueRef: 1, externalContextProvided: false, commitMessages: [...shared, "docs: update README"] } });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.decisionQuality.commitsTotal, 3); // 3 unique messages
    assert.equal(agg.decisionQuality.commitMessages.length, 3);
  });

  it("averages prompt effectiveness scores", () => {
    const r1 = makeReport({
      promptEffectiveness: {
        available: true, events: [], coaching: [],
        scores: { contextProvision: 0.4, scopeDiscipline: 0.6, feedbackQuality: 0.2, decomposition: 0.8, verification: 0.6 },
        overallScore: 0.5, rating: "moderate", observation: "",
      },
    });
    const r2 = makeReport({
      promptEffectiveness: {
        available: true, events: [], coaching: ["tip1"],
        scores: { contextProvision: 0.8, scopeDiscipline: 0.8, feedbackQuality: 0.6, decomposition: 0.6, verification: 0.8 },
        overallScore: 0.7, rating: "good", observation: "",
      },
    });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.promptEffectiveness.available, true);
    assert.equal(agg.promptEffectiveness.scores.contextProvision, 0.6);
    assert.equal(agg.promptEffectiveness.scores.scopeDiscipline, 0.7);
    assert.equal(agg.promptEffectiveness.overallScore, 0.6);
    assert.deepEqual(agg.promptEffectiveness.coaching, ["tip1"]);
  });

  it("handles sessions with unavailable prompt effectiveness", () => {
    const r1 = makeReport({
      promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "", coaching: [] },
    });
    const r2 = makeReport({
      promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "", coaching: [] },
    });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.promptEffectiveness.available, false);
  });

  it("takes interaction pattern from first report", () => {
    const r1 = makeReport({ interactionPattern: { userStyle: "collaborative", contextProvision: "inline", observation: "from main" } });
    const r2 = makeReport({ interactionPattern: { userStyle: "directive", contextProvision: "structured", observation: "from engineer" } });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.interactionPattern.userStyle, "collaborative");
    assert.equal(agg.interactionPattern.observation, "from main");
  });

  it("computes leverage from aggregated metrics", () => {
    const r1 = makeReport({ convergence: { exchanges: 2, outcomes: 2, rate: 1.0, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 0, blindRetries: 0, pivot: null } });
    const r2 = makeReport({ convergence: { exchanges: 2, outcomes: 2, rate: 1.0, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 0, blindRetries: 0, pivot: null } });

    const agg = aggregateReports([r1, r2], "test");
    assert.ok(agg.leverageScore >= 0 && agg.leverageScore <= 1);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(agg.interactionLeverage));
  });

  it("handles single session", () => {
    const r1 = makeReport();
    const agg = aggregateReports([r1], "test");
    assert.equal(agg.convergence.exchanges, r1.convergence.exchanges);
    assert.equal(agg.convergence.outcomes, r1.convergence.outcomes);
  });

  it("handles zero outcomes gracefully", () => {
    const r1 = makeReport({ convergence: { exchanges: 3, outcomes: 0, rate: 0, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 0, blindRetries: 0, pivot: null } });
    const r2 = makeReport({ convergence: { exchanges: 2, outcomes: 0, rate: 0, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 0, blindRetries: 0, pivot: null } });

    const agg = aggregateReports([r1, r2], "test");
    assert.equal(agg.convergence.rate, 0);
    assert.equal(agg.convergence.exchanges, 5);
  });
});

describe("formatThreadReport", () => {
  it("shows agent breakdown table and aggregate", () => {
    const r1 = makeReport();
    const r2 = makeReport({ convergence: { exchanges: 3, outcomes: 2, rate: 1.5, reworkInstances: 0, reworkPercent: 0, duplicateCommits: 0, blindRetries: 0, pivot: null }, leverageScore: 0.72 });

    const threadReport: ThreadPulseReport = {
      timestamp: "2026-03-27T12:00:00.000Z",
      worktreeId: "12345",
      project: "test-project",
      agents: [
        { role: "pm", sessionPath: "/tmp/pm.jsonl", report: r1 },
        { role: "engineer", sessionPath: "/tmp/eng.jsonl", report: r2 },
      ],
      aggregate: aggregateReports([r1, r2], "test-project"),
    };

    const output = formatThreadReport(threadReport);
    assert.ok(output.includes("Thread 12345"));
    assert.ok(output.includes("test-project"));
    assert.ok(output.includes("2 agent(s)"));
    assert.ok(output.includes("AGENT BREAKDOWN"));
    assert.ok(output.includes("pm"));
    assert.ok(output.includes("engineer"));
    assert.ok(output.includes("AGGREGATE"));
  });

  it("shows single agent thread", () => {
    const r1 = makeReport();
    const threadReport: ThreadPulseReport = {
      timestamp: "2026-03-27T12:00:00.000Z",
      worktreeId: "99999",
      project: "solo",
      agents: [{ role: "main", sessionPath: "/tmp/main.jsonl", report: r1 }],
      aggregate: aggregateReports([r1], "solo"),
    };

    const output = formatThreadReport(threadReport);
    assert.ok(output.includes("Thread 99999"));
    assert.ok(output.includes("1 agent(s)"));
    assert.ok(output.includes("main"));
  });
});
