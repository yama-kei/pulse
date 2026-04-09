import { SessionEconomicsSignal, ThrashingEpisode, TokenUsageSignal, ConvergenceSignal, ModelPricing } from "../types/pulse.js";
import { readFileSync } from "node:fs";

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

// ── JSONL helpers ─────────────────────────────────────────────────────────────

interface RawLine {
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

/** Read all timestamps from a JSONL session file. */
export function readTimestamps(sessionPath: string): number[] {
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const results: number[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj: RawLine = JSON.parse(line);
        if (obj.timestamp) {
          const ms = Date.parse(obj.timestamp);
          if (!isNaN(ms)) results.push(ms);
        }
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ── Time analysis ─────────────────────────────────────────────────────────────

interface TimeAnalysis {
  durationMs: number;
  activeMs: number;
  idleMs: number;
  idleGaps: number;
}

/** Compute duration/active/idle from a sorted list of timestamps (ms). */
export function analyzeTime(timestamps: number[]): TimeAnalysis {
  if (timestamps.length < 2) {
    return { durationMs: 0, activeMs: 0, idleMs: 0, idleGaps: 0 };
  }

  const sorted = [...timestamps].sort((a, b) => a - b);
  const durationMs = sorted[sorted.length - 1] - sorted[0];

  let idleMs = 0;
  let idleGaps = 0;

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > IDLE_THRESHOLD_MS) {
      idleMs += gap;
      idleGaps += 1;
    }
  }

  const activeMs = durationMs - idleMs;

  return { durationMs, activeMs, idleMs, idleGaps };
}

// ── Thrashing detection ───────────────────────────────────────────────────────

function makeEpisode(start: number, end: number, exchanges: number, totalExchanges: number, totalTokens: number): ThrashingEpisode {
  return {
    startExchange: start,
    endExchange: end,
    exchanges,
    estimatedTokens: totalExchanges > 0 ? Math.round((exchanges / totalExchanges) * totalTokens) : 0,
  };
}

function detectThrashing(convergence: ConvergenceSignal, tokenUsage: TokenUsageSignal): ThrashingEpisode[] {
  const totalExchanges = convergence.exchanges;
  if (totalExchanges < 4) return [];

  const decisionIndices = new Set(
    (convergence.decisionEvents ?? []).map(e => e.atExchange)
  );

  const episodes: ThrashingEpisode[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < totalExchanges; i++) {
    if (decisionIndices.has(i)) {
      if (runStart !== null) {
        const runLen = i - runStart;
        if (runLen >= 4) {
          episodes.push(makeEpisode(runStart, i - 1, runLen, totalExchanges, tokenUsage.totalTokens));
        }
      }
      runStart = null;
    } else {
      if (runStart === null) runStart = i;
    }
  }

  if (runStart !== null) {
    const runLen = totalExchanges - runStart;
    if (runLen >= 4) {
      episodes.push(makeEpisode(runStart, totalExchanges - 1, runLen, totalExchanges, tokenUsage.totalTokens));
    }
  }

  return episodes;
}

// ── Cost model ────────────────────────────────────────────────────────────────

const MODEL_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: "claude-opus-4",   pricing: { inputPerMTok: 15,   outputPerMTok: 75  } },
  { prefix: "claude-sonnet-4", pricing: { inputPerMTok: 3,    outputPerMTok: 15  } },
  { prefix: "claude-haiku-4",  pricing: { inputPerMTok: 0.80, outputPerMTok: 4   } },
];

function findPricing(model: string): ModelPricing | null {
  for (const entry of MODEL_PRICING) {
    if (model.startsWith(entry.prefix)) return entry.pricing;
  }
  return null;
}

interface PerMessageCost {
  inputTokens: number;
  outputTokens: number;
  pricing: ModelPricing;
}

function readPerMessageCosts(sessionPath: string): PerMessageCost[] | null {
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const results: PerMessageCost[] = [];
    let anyModel = false;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj: RawLine = JSON.parse(line);
        if (obj.message?.role !== "assistant") continue;
        const model = obj.message.model;
        if (!model) continue;
        anyModel = true;
        const pricing = findPricing(model);
        if (!pricing) continue;
        const usage = obj.message.usage;
        if (!usage) continue;
        results.push({
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          pricing,
        });
      } catch {
        // skip malformed lines
      }
    }

    return anyModel ? results : null;
  } catch {
    return null;
  }
}

function computeCost(sessionPath: string | null): number | null {
  if (!sessionPath) return null;
  const messages = readPerMessageCosts(sessionPath);
  if (messages === null) return null;

  let total = 0;
  for (const msg of messages) {
    total += (msg.inputTokens / 1_000_000) * msg.pricing.inputPerMTok;
    total += (msg.outputTokens / 1_000_000) * msg.pricing.outputPerMTok;
  }

  return Math.round(total * 10000) / 10000;
}

// ── Main extractor ────────────────────────────────────────────────────────────

export function extractSessionEconomics(
  sessionPath: string | null,
  tokenUsage: TokenUsageSignal,
  convergence: ConvergenceSignal
): SessionEconomicsSignal {
  // Time analysis
  const timestamps = sessionPath ? readTimestamps(sessionPath) : [];
  const time = analyzeTime(timestamps);

  // Thrashing detection
  const thrashingEpisodes = detectThrashing(convergence, tokenUsage);
  const thrashingTokens = thrashingEpisodes.reduce((sum, ep) => sum + ep.estimatedTokens, 0);

  // Dollar cost
  const costDollars = computeCost(sessionPath);

  // Tokens per decision
  const decisionCount = convergence.decisionEvents?.length ?? 0;
  const tokensPerDecision = decisionCount > 0
    ? Math.round(tokenUsage.totalTokens / decisionCount)
    : Infinity;

  return {
    durationMs: time.durationMs,
    activeMs: time.activeMs,
    idleMs: time.idleMs,
    idleGaps: time.idleGaps,
    thrashingEpisodes,
    costDollars,
    tokensPerDecision,
    thrashingTokens,
  };
}


