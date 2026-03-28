import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { runHistory } from "./history.js";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-history-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeReport(projectDir: string, report: Record<string, unknown>): void {
  const pulseDir = join(projectDir, ".pulse");
  mkdirSync(pulseDir, { recursive: true });
  const ts = (report.timestamp as string).replace(/[:.]/g, "-");
  writeFileSync(join(pulseDir, `pulse-${ts}.json`), JSON.stringify(report));
}

function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2026-03-25T10:00:00.000Z",
    project: "test-proj",
    cwd: "/tmp/test",
    convergence: { exchanges: 5, outcomes: 3, rate: 1.67, reworkInstances: 1, reworkPercent: 20 },
    intentAnchoring: { intentsPresent: false, claudeMdPresent: false, declaredIntents: [], relevantIntents: [], referencedIntents: [], gap: [], intentLayerCheck: null },
    decisionQuality: { commitsTotal: 3, commitsWithWhy: 1, commitsWithIssueRef: 2, externalContextProvided: false, commitMessages: [] },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, tokensPerExchange: 0, tokensPerOutcome: 0, available: false },
    interactionPattern: { userStyle: "directive", contextProvision: "structured", observation: "" },
    promptEffectiveness: { available: false, events: [], scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 }, overallScore: 0, rating: "developing", observation: "" },
    interactionLeverage: "MEDIUM",
    ...overrides,
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { execSync(`rm -rf "${d}"`); } catch {}
  }
  tmpDirs = [];
});

describe("runHistory", () => {
  it("returns JSON array of report summaries sorted by date", () => {
    const dir = makeTmpDir();
    writeReport(dir, makeReport({ timestamp: "2026-03-25T10:00:00.000Z" }));
    writeReport(dir, makeReport({ timestamp: "2026-03-26T10:00:00.000Z", interactionLeverage: "HIGH" }));
    writeReport(dir, makeReport({ timestamp: "2026-03-27T10:00:00.000Z", interactionLeverage: "LOW" }));

    const result = runHistory(["--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].timestamp, "2026-03-25T10:00:00.000Z");
    assert.equal(parsed[1].timestamp, "2026-03-26T10:00:00.000Z");
    assert.equal(parsed[2].timestamp, "2026-03-27T10:00:00.000Z");
    assert.equal(parsed[0].leverage, "MEDIUM");
    assert.equal(parsed[1].leverage, "HIGH");
    assert.equal(parsed[2].leverage, "LOW");
  });

  it("each summary includes expected fields", () => {
    const dir = makeTmpDir();
    writeReport(dir, makeReport({
      timestamp: "2026-03-25T10:00:00.000Z",
      convergence: { exchanges: 5, outcomes: 3, rate: 1.67, reworkInstances: 1, reworkPercent: 20 },
      promptEffectiveness: { available: true, events: [], scores: { contextProvision: 0.6, scopeDiscipline: 0.7, feedbackQuality: 0.8, decomposition: 0.5, verification: 0.9 }, overallScore: 0.72, rating: "good", observation: "" },
    }));

    const result = runHistory(["--json"], dir);
    const parsed = JSON.parse(result);
    const entry = parsed[0];
    assert.equal(entry.timestamp, "2026-03-25T10:00:00.000Z");
    assert.equal(entry.convergence_rate, 1.67);
    assert.equal(entry.prompt_effectiveness, 0.72);
    assert.equal(entry.leverage, "MEDIUM");
    assert.equal(entry.outcomes, 3);
    assert.equal(entry.rework_percent, 20);
  });

  it("filters by --range", () => {
    const dir = makeTmpDir();
    writeReport(dir, makeReport({ timestamp: "2026-03-20T10:00:00.000Z" }));
    writeReport(dir, makeReport({ timestamp: "2026-03-27T10:00:00.000Z" }));

    const result = runHistory(["--range", "3d", "--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].timestamp, "2026-03-27T10:00:00.000Z");
  });

  it("returns empty array when no reports exist", () => {
    const dir = makeTmpDir();
    const result = runHistory(["--json"], dir);
    const parsed = JSON.parse(result);
    assert.deepStrictEqual(parsed, []);
  });

  it("returns readable table by default", () => {
    const dir = makeTmpDir();
    writeReport(dir, makeReport({ timestamp: "2026-03-25T10:00:00.000Z" }));
    writeReport(dir, makeReport({ timestamp: "2026-03-26T10:00:00.000Z" }));

    const result = runHistory([], dir);
    assert.ok(result.includes("DATE"));
    assert.ok(result.includes("CONVERGENCE"));
    assert.ok(result.includes("LEVERAGE"));
    assert.ok(result.includes("2026-03-25"));
    assert.ok(result.includes("2026-03-26"));
  });

  it("shows 'No reports found' for empty .pulse directory", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, ".pulse"), { recursive: true });
    const result = runHistory([], dir);
    assert.equal(result, "No reports found.");
  });

  it("skips malformed JSON files gracefully", () => {
    const dir = makeTmpDir();
    const pulseDir = join(dir, ".pulse");
    mkdirSync(pulseDir, { recursive: true });
    writeFileSync(join(pulseDir, "pulse-2026-03-25T10-00-00-000Z.json"), "not json");
    writeReport(dir, makeReport({ timestamp: "2026-03-26T10:00:00.000Z" }));

    const result = runHistory(["--json"], dir);
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 1);
  });
});
