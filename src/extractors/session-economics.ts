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
  let lastIdleEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > IDLE_THRESHOLD_MS) {
      idleMs += gap;
      idleGaps += 1;
      lastIdleEnd = sorted[i];
    }
  }

  // activeMs = time from the end of the last idle gap to the end of the session
  const activeMs = sorted[sorted.length - 1] - lastIdleEnd;

  return { durationMs, activeMs, idleMs, idleGaps };
}

// ── Placeholders ──────────────────────────────────────────────────────────────

function detectThrashing(_convergence: ConvergenceSignal, _tokenUsage: TokenUsageSignal): ThrashingEpisode[] {
  return [];
}

function computeCost(_sessionPath: string | null): number | null {
  return null;
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

  // Thrashing (placeholder)
  const thrashingEpisodes = detectThrashing(convergence, tokenUsage);
  const thrashingTokens = thrashingEpisodes.reduce((sum, ep) => sum + ep.estimatedTokens, 0);

  // Cost (placeholder)
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

// Suppress unused import warning — ModelPricing will be used in Task 4
void (0 as unknown as ModelPricing);
