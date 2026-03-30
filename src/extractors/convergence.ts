import { ConvergenceSignal } from "../types/pulse.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface SessionMessage {
  type: string;
  message?: { role?: string; content?: unknown };
}

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

/** Time window extracted from the session JSONL */
export interface SessionTimeWindow {
  start: string | null;
  end: string | null;
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
  let sessionOutcomes = 0;

  if (sessionPath) {
    const parsed = parseSessionMessages(sessionPath);
    exchanges = parsed.exchanges;
    reworkInstances = parsed.reworkInstances;
    sessionOutcomes = parsed.outcomes;
  }

  // Outcomes: max of session-derived outcomes and git filesChanged. Floor at 1 to avoid division by zero.
  const outcomes = Math.max(sessionOutcomes, filesChanged, 1);
  const rate = exchanges > 0 ? round(exchanges / outcomes, 2) : 0;
  const reworkPercent = exchanges > 0 ? round((reworkInstances / exchanges) * 100, 1) : 0;

  return { exchanges, outcomes, rate, reworkInstances, reworkPercent };
}

/**
 * Extract the time window (first and last timestamp) from a session JSONL file.
 * Used to scope git queries to the same period as the session.
 */
export function extractSessionTimeWindow(sessionPath: string | null): SessionTimeWindow {
  if (!sessionPath) return { start: null, end: null };

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let start: string | null = null;
    let end: string | null = null;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.timestamp) {
          if (!start) start = msg.timestamp;
          end = msg.timestamp;
        }
      } catch {
        // skip malformed lines
      }
    }

    return { start, end };
  } catch {
    return { start: null, end: null };
  }
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
  /\bactually\b/i,
  /\bdon'?t do\b/i,
  /\bstop\b/i,
  /\bgo back\b/i,
  /\bthat'?s not what/i,
  /\bthat'?s not correct/i,
  /\bnot what I\b/i,
  /\bretry\b/i,
  /\btry again\b/i,
  /\bredo\b/i,
  /\broll ?back\b/i,
  /\bwait[,.]?\s/i,
  /\bhold on\b/i,
  /\bnever mind\b/i,
  /\bscratch that\b/i,
  // Blind-retry patterns: user reports fix didn't work (#30)
  /\bnot fixed\b/i,
  /\bdidn'?t (?:fix|work|help|change)\b/i,
  /\bdoesn'?t (?:work|help|fix)\b/i,
  /\bstill (?:broken|failing|happening|the same|not working|not fixed|expands?|shows?)\b/i,
  /\bgot worse\b/i,
  /\bgetting worse\b/i,
  /\bsame (?:issue|problem|error|bug)\b/i,
  /\bno (?:change|difference|improvement|effect)\b/i,
  /\bnot working\b/i,
];

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const GH_ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
const ISSUE_REF_RE = /#(\d+)/g;

/**
 * Extract issue references from a git commit command's message flag.
 * Returns set of issue numbers like {"93", "42"}.
 */
function extractIssueRefs(commitCmd: string): Set<string> {
  const refs = new Set<string>();
  // Match -m "..." or -m '...' content
  const msgMatch = commitCmd.match(/-m\s+["']([^"']+)["']/);
  if (msgMatch) {
    for (const m of msgMatch[1].matchAll(ISSUE_REF_RE)) {
      refs.add(m[1]);
    }
  }
  return refs;
}

function parseSessionMessages(sessionPath: string): {
  exchanges: number;
  reworkInstances: number;
  outcomes: number;
} {
  let exchanges = 0;
  let reworkInstances = 0;
  const editedFiles = new Set<string>();
  let commits = 0;
  const commitIssueRefs = new Set<string>();
  let prs = 0;
  let issues = 0;

  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const msg: SessionMessage = JSON.parse(line);

        if (msg.type === "user") {
          const text = extractText(msg);
          if (!text || text.trim().length === 0) continue;
          if (isSystemMessage(text)) continue;

          exchanges++;

          if (REWORK_PATTERNS.some(p => p.test(text))) {
            reworkInstances++;
          }
        } else if (msg.type === "assistant") {
          // Count tool_use blocks as outcomes
          const blocks = msg.message?.content;
          if (!Array.isArray(blocks)) continue;

          for (const block of blocks) {
            if (block?.type !== "tool_use") continue;
            const name: string = block.name || "";
            const input: Record<string, unknown> = block.input || {};

            if (name === "Write" || name === "Edit") {
              const fp = input.file_path;
              if (typeof fp === "string") editedFiles.add(fp);
            } else if (name === "Bash") {
              const cmd = typeof input.command === "string" ? input.command : "";
              if (GIT_COMMIT_RE.test(cmd)) {
                const refs = extractIssueRefs(cmd);
                if (refs.size > 0) {
                  // Deduplicate: commits to the same issue count as one outcome
                  for (const ref of refs) commitIssueRefs.add(ref);
                } else {
                  commits++;
                }
              }
              if (GH_PR_CREATE_RE.test(cmd)) prs++;
              if (GH_ISSUE_CREATE_RE.test(cmd)) issues++;
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // session file unreadable
  }

  // Commits with issue refs are deduplicated (N commits to #93 = 1 outcome).
  // Commits without issue refs count individually.
  const outcomes = editedFiles.size + commits + commitIssueRefs.size + prs + issues;
  return { exchanges, reworkInstances, outcomes };
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

/** Filter out system/skill messages that have type "user" but aren't human input */
function isSystemMessage(text: string): boolean {
  return (
    text.startsWith("Base directory for this skill:") ||
    text.includes("/.claude/plugins/")
  );
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
