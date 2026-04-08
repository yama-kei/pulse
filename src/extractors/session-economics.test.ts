import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { extractSessionEconomics } from "./session-economics.js";
import { TokenUsageSignal, ConvergenceSignal } from "../types/pulse.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createSessionFile(entries: Array<{ type: string; timestamp: string; model?: string; input_tokens?: number; output_tokens?: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-econ-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  const lines = entries.map(e => {
    const obj: any = { type: e.type, timestamp: e.timestamp };
    if (e.type === "user") {
      obj.message = { role: "user", content: "test message" };
    } else {
      obj.message = { role: "assistant", content: "response" };
      if (e.model) obj.message.model = e.model;
      if (e.input_tokens !== undefined || e.output_tokens !== undefined) {
        obj.message.usage = {
          input_tokens: e.input_tokens ?? 0,
          output_tokens: e.output_tokens ?? 0,
        };
      }
    }
    return JSON.stringify(obj);
  });
  writeFileSync(filePath, lines.join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

function makeTokenUsage(overrides?: Partial<TokenUsageSignal>): TokenUsageSignal {
  return {
    inputTokens: 10000, outputTokens: 5000, totalTokens: 15000,
    tokensPerExchange: 3000, tokensPerOutcome: 5000, available: true,
    ...overrides,
  };
}

function makeConvergence(overrides?: Partial<ConvergenceSignal>): ConvergenceSignal {
  return {
    exchanges: 5, outcomes: 3, rate: 1.67,
    reworkInstances: 0, reworkPercent: 0,
    duplicateCommits: 0, blindRetries: 0, pivot: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of tmpDirs) { try { rmdirSync(d); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

// ── Task 2: Time analysis ─────────────────────────────────────────────────────

describe("extractSessionEconomics - time analysis", () => {
  it("computes duration from first to last timestamp", () => {
    const t0 = "2024-01-01T10:00:00.000Z";
    const t1 = "2024-01-01T10:03:00.000Z";
    const t2 = "2024-01-01T10:07:00.000Z";
    const t3 = "2024-01-01T10:11:00.000Z";
    const filePath = createSessionFile([
      { type: "user", timestamp: t0 },
      { type: "assistant", timestamp: t1 },
      { type: "user", timestamp: t2 },
      { type: "assistant", timestamp: t3 },
    ]);
    const result = extractSessionEconomics(filePath, makeTokenUsage(), makeConvergence());
    assert.equal(result.durationMs, 660000);
  });

  it("detects idle gaps > 5 minutes", () => {
    const t0 = "2024-01-01T10:00:00.000Z";
    const t1 = "2024-01-01T10:02:00.000Z";
    const t2 = "2024-01-01T10:12:00.000Z";
    const t3 = "2024-01-01T10:14:00.000Z";
    const filePath = createSessionFile([
      { type: "user", timestamp: t0 },
      { type: "assistant", timestamp: t1 },
      { type: "user", timestamp: t2 },
      { type: "assistant", timestamp: t3 },
    ]);
    const result = extractSessionEconomics(filePath, makeTokenUsage(), makeConvergence());
    assert.equal(result.idleGaps, 1);
    assert.equal(result.idleMs, 600000);
    assert.equal(result.activeMs, 120000);
  });

  it("does not flag gaps <= 5 minutes as idle", () => {
    const t0 = "2024-01-01T10:00:00.000Z";
    const t1 = "2024-01-01T10:03:00.000Z";
    const filePath = createSessionFile([
      { type: "user", timestamp: t0 },
      { type: "assistant", timestamp: t1 },
    ]);
    const result = extractSessionEconomics(filePath, makeTokenUsage(), makeConvergence());
    assert.equal(result.idleGaps, 0);
  });

  it("returns zero duration for null session path", () => {
    const result = extractSessionEconomics(null, makeTokenUsage(), makeConvergence());
    assert.equal(result.durationMs, 0);
    assert.equal(result.activeMs, 0);
    assert.equal(result.idleMs, 0);
    assert.equal(result.idleGaps, 0);
  });

  it("handles single-message session", () => {
    const filePath = createSessionFile([
      { type: "user", timestamp: "2024-01-01T10:00:00.000Z" },
    ]);
    const result = extractSessionEconomics(filePath, makeTokenUsage(), makeConvergence());
    assert.equal(result.durationMs, 0);
  });
});

// ── Task 3: Thrashing detection ───────────────────────────────────────────────

describe("extractSessionEconomics - thrashing detection", () => {
  it("detects thrashing when 4+ exchanges have no decisions", () => {
    // 5 exchanges, decision at 0 → episode at 1-4
    const convergence = makeConvergence({
      exchanges: 5,
      decisionEvents: [{ atExchange: 0, type: "approved", detail: "approved" }],
    });
    const tokenUsage = makeTokenUsage({ totalTokens: 50000 });
    const result = extractSessionEconomics(null, tokenUsage, convergence);
    assert.equal(result.thrashingEpisodes.length, 1);
    assert.equal(result.thrashingEpisodes[0].startExchange, 1);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
    assert.equal(result.thrashingEpisodes[0].estimatedTokens, 40000);
  });

  it("does not flag thrashing for sequences < 4 exchanges", () => {
    const convergence = makeConvergence({
      exchanges: 3,
      decisionEvents: [{ atExchange: 0, type: "approved", detail: "approved" }],
    });
    const result = extractSessionEconomics(null, makeTokenUsage(), convergence);
    assert.equal(result.thrashingEpisodes.length, 0);
  });

  it("detects multiple thrashing episodes separated by decisions", () => {
    // 10 exchanges, decisions at 0 and 5 → episodes at 1-4 and 6-9
    const convergence = makeConvergence({
      exchanges: 10,
      decisionEvents: [
        { atExchange: 0, type: "approved", detail: "approved" },
        { atExchange: 5, type: "approved", detail: "approved" },
      ],
    });
    const tokenUsage = makeTokenUsage({ totalTokens: 100000 });
    const result = extractSessionEconomics(null, tokenUsage, convergence);
    assert.equal(result.thrashingEpisodes.length, 2);
    assert.equal(result.thrashingEpisodes[0].startExchange, 1);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
    assert.equal(result.thrashingEpisodes[1].startExchange, 6);
    assert.equal(result.thrashingEpisodes[1].endExchange, 9);
  });

  it("flags entire session as thrashing if 0 decisions and 4+ exchanges", () => {
    const convergence = makeConvergence({
      exchanges: 5,
      decisionEvents: [],
    });
    const tokenUsage = makeTokenUsage({ totalTokens: 50000 });
    const result = extractSessionEconomics(null, tokenUsage, convergence);
    assert.equal(result.thrashingEpisodes.length, 1);
    assert.equal(result.thrashingEpisodes[0].startExchange, 0);
    assert.equal(result.thrashingEpisodes[0].endExchange, 4);
  });

  it("no thrashing if 0 decisions and < 4 exchanges", () => {
    const convergence = makeConvergence({
      exchanges: 1,
      decisionEvents: [],
    });
    const result = extractSessionEconomics(null, makeTokenUsage(), convergence);
    assert.equal(result.thrashingEpisodes.length, 0);
  });
});
