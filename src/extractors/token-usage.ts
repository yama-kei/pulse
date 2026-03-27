import { TokenUsageSignal } from "../types/pulse.js";
import { readFileSync } from "node:fs";

interface SessionLine {
  message?: {
    role?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
}

/**
 * Extract token usage from a Claude Code session JSONL file.
 *
 * Sums input_tokens and output_tokens from assistant message usage fields.
 * Returns derived ratios (tokens per exchange, tokens per outcome) for
 * correlation analysis against other quality signals.
 */
export function extractTokenUsage(
  sessionPath: string | null,
  exchanges: number,
  outcomes: number
): TokenUsageSignal {
  const empty: TokenUsageSignal = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokensPerExchange: 0,
    tokensPerOutcome: 0,
    available: false,
  };

  if (!sessionPath) return empty;

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const msg: SessionLine = JSON.parse(line);
        if (msg.message?.role !== "assistant") continue;

        const usage = msg.message.usage;
        if (!usage) continue;

        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return empty;
  }

  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) return empty;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    tokensPerExchange: exchanges > 0 ? round(totalTokens / exchanges, 0) : 0,
    tokensPerOutcome: outcomes > 0 ? round(totalTokens / outcomes, 0) : 0,
    available: true,
  };
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
