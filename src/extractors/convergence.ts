import { ConvergenceSignal } from "../types/pulse.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface SessionMessage {
  type: string;
  message?: { role?: string; content?: unknown };
}

/**
 * Extract convergence signal from a Claude Code session JSONL file.
 *
 * Counts:
 * - Human exchanges: distinct user messages with non-empty content
 * - Outcomes: approximated from git diff --stat (files changed) + tool actions
 * - Rework: user messages containing revision/undo language
 */
export function extractConvergence(
  sessionPath: string | null,
  filesChanged: number
): ConvergenceSignal {
  let exchanges = 0;
  let reworkInstances = 0;

  if (sessionPath) {
    const parsed = parseSessionMessages(sessionPath);
    exchanges = parsed.exchanges;
    reworkInstances = parsed.reworkInstances;
  }

  // Outcomes: at minimum, files changed in git. Floor at 1 to avoid division by zero.
  const outcomes = Math.max(filesChanged, 1);
  const rate = exchanges > 0 ? round(exchanges / outcomes, 2) : 0;
  const reworkPercent = exchanges > 0 ? round((reworkInstances / exchanges) * 100, 1) : 0;

  return { exchanges, outcomes, rate, reworkInstances, reworkPercent };
}

/**
 * Find the most recent session JSONL file for a Claude Code project directory.
 * Claude Code stores sessions at ~/.claude/projects/{encoded-path}/{session-id}.jsonl
 */
export function findSessionFile(projectDir: string): string | null {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const encoded = projectDir.replace(/\//g, "-").replace(/^-/, "-");

  // Try multiple encodings — Claude Code uses different path separators
  const claudeProjectsDir = join(home, ".claude", "projects");
  let candidates: string[] = [];

  try {
    const dirs = readdirSync(claudeProjectsDir);
    // Claude Code encodes paths by replacing / with -
    // e.g. /home/yamakei/Documents/HouseholdOS -> -home-yamakei-Documents-HouseholdOS
    const projectEncoded = projectDir.replace(/\//g, "-");
    for (const dir of dirs) {
      // Match: exact encoded path, or dir starts with encoded path (worktrees)
      if (dir === projectEncoded || dir.startsWith(projectEncoded + "-")) {
        const fullDir = join(claudeProjectsDir, dir);
        try {
          const files = readdirSync(fullDir).filter(f => f.endsWith(".jsonl"));
          for (const f of files) {
            candidates.push(join(fullDir, f));
          }
        } catch {
          // skip unreadable dirs
        }
      }
    }
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;

  // Return the most recently modified
  let best = candidates[0];
  let bestTime = 0;
  for (const c of candidates) {
    try {
      const { mtimeMs } = require("node:fs").statSync(c);
      if (mtimeMs > bestTime) {
        bestTime = mtimeMs;
        best = c;
      }
    } catch {
      // skip
    }
  }
  return best;
}

const REWORK_PATTERNS = [
  /\bundo\b/i,
  /\brevert\b/i,
  /\bno[, ]+not that\b/i,
  /\bwrong\b/i,
  /\binstead\b/i,
  /\bactually[, ]+/i,
  /\bdon'?t do\b/i,
  /\bstop\b/i,
  /\bgo back\b/i,
  /\bthat'?s not what/i,
  /\bretry\b/i,
  /\bredo\b/i,
  /\broll ?back\b/i,
];

function parseSessionMessages(sessionPath: string): {
  exchanges: number;
  reworkInstances: number;
} {
  let exchanges = 0;
  let reworkInstances = 0;

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const msg: SessionMessage = JSON.parse(line);
        if (msg.type !== "user") continue;

        // Extract text content
        const text = extractText(msg);
        if (!text || text.trim().length === 0) continue;

        exchanges++;

        // Check for rework language
        if (REWORK_PATTERNS.some(p => p.test(text))) {
          reworkInstances++;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // session file unreadable
  }

  return { exchanges, reworkInstances };
}

function extractText(msg: SessionMessage): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join(" ");
  }
  return "";
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
