import { ConvergenceSignal, PivotSignal, AgentConvergenceStats, CorrelatedMpgData } from "../types/pulse.js";
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
  filesChanged: number,
  mpgData?: CorrelatedMpgData | null
): ConvergenceSignal {
  let exchanges = 0;
  let reworkInstances = 0;
  let sessionOutcomes = 0;
  let duplicateCommits = 0;
  let blindRetries = 0;
  let pivot: PivotSignal | null = null;

  if (sessionPath) {
    const parsed = parseSessionMessages(sessionPath);
    exchanges = parsed.exchanges;
    reworkInstances = parsed.reworkInstances;
    sessionOutcomes = parsed.outcomes;
    duplicateCommits = parsed.duplicateCommits;
    blindRetries = parsed.blindRetries;
    pivot = parsed.pivot;
  }

  // Outcomes: max of session-derived outcomes and git filesChanged. Floor at 1 to avoid division by zero.
  const outcomes = Math.max(sessionOutcomes, filesChanged, 1);
  const rate = exchanges > 0 ? round(exchanges / outcomes, 2) : 0;
  const reworkPercent = exchanges > 0 ? round((reworkInstances / exchanges) * 100, 1) : 0;

  const signal: ConvergenceSignal = {
    exchanges, outcomes, rate, reworkInstances, reworkPercent,
    duplicateCommits, blindRetries, pivot,
  };

  // Enrich with per-agent breakdown when MPG data is available
  if (mpgData && mpgData.events.length > 0) {
    signal.agentBreakdown = computeAgentBreakdown(mpgData);
  }

  return signal;
}

/**
 * Compute per-agent convergence stats from correlated MPG events.
 * Groups message_routed events by agent_target, counts errors,
 * and computes a convergence penalty based on error rate.
 */
export function computeAgentBreakdown(mpgData: CorrelatedMpgData): AgentConvergenceStats[] {
  const agentMap = new Map<string, { messages: number; errors: number }>();

  for (const event of mpgData.events) {
    if (event.event_type !== "message_routed") continue;
    const agent = event.agent_target || event.persona || "unknown";
    const entry = agentMap.get(agent) || { messages: 0, errors: 0 };
    entry.messages++;
    if (event.is_error) entry.errors++;
    agentMap.set(agent, entry);
  }

  const stats: AgentConvergenceStats[] = [];
  for (const [agent, data] of agentMap) {
    const errorRate = data.messages > 0 ? round((data.errors / data.messages) * 100, 1) : 0;
    const convergencePenalty = round(data.errors * 0.5, 2);
    stats.push({ agent, messages: data.messages, errors: data.errors, errorRate, convergencePenalty });
  }

  stats.sort((a, b) => b.messages - a.messages);
  return stats;
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
    const projectEncoded = projectDir.replace(/\//g, "-");
    for (const dir of dirs) {
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
  /\bnot\s+fixed\b/i,
  /\bdidn'?t\s+(?:fix|work|help|change)/i,
  /\bdoesn'?t\s+(?:work|help|fix)/i,
  /\bstill\s+(?:broken|failing|happening|the same|not working|not fixed|expands?|shows?)\b/i,
  /\bstill\s+\w+ing\b/i,
  /\bgot\s+worse\b/i,
  /\bgetting\s+worse\b/i,
  /\bnot\s+working\b/i,
  /\bsame\s+(issue|problem|error|bug)\b/i,
  /\bno\s+(change|difference|improvement|effect)\b/i,
];

/** Patterns indicating the user is asking a diagnostic question, not ordering a fix */
const DIAGNOSTIC_PATTERNS = [
  /\bwhy\b.*\?/i,
  /\bwhat(?:'s| is) (?:causing|the (?:root cause|reason|problem|issue))/i,
  /\bdebug\b/i,
  /\bexplain (?:why|what)/i,
  /\bcheck (?:the )?(?:logs?|errors?|output|console)\b/i,
  /\blook (?:at|into) (?:the |this |what)/i,
];

/** Patterns indicating user pivoted to structured approach */
const PIVOT_PATTERNS = [
  /\b(?:file|create|open) (?:an? )?issue\b/i,
  /\btrack (?:this|the|it)\b/i,
];

/** Patterns indicating user is asking for a root cause investigation (stronger pivot) */
const ROOT_CAUSE_REQUEST_PATTERNS = [
  /\binvestigat/i,
  /\broot cause\b/i,
  /\bfind (?:the |out )(?:cause|why|what)/i,
  /\bdiagnos/i,
  /\bwhy (?:is|does|did) (?:this|it)\b/i,
];

const GIT_COMMIT_RE = /\bgit\s+commit\b/;
const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const GH_ISSUE_CREATE_RE = /\bgh\s+issue\s+create\b/;
const COMMIT_MSG_RE = /-m\s+(?:"([^"]*?)"|'([^']*?)')/;
const ISSUE_REF_RE = /#(\d+)/g;

function parseSessionMessages(sessionPath: string): {
  exchanges: number;
  reworkInstances: number;
  outcomes: number;
  duplicateCommits: number;
  blindRetries: number;
  pivot: PivotSignal | null;
} {
  let exchanges = 0;
  let reworkInstances = 0;
  const editedFiles = new Set<string>();
  let commits = 0;
  let duplicateCommits = 0;
  const seenIssueRefs = new Set<string>();
  let prs = 0;
  let issues = 0;

  // Track message flow for blind-retry and pivot detection
  const messageClasses: Array<"rework" | "diagnostic" | "pivot_issue" | "pivot_rootcause" | "other"> = [];
  let agentActedSinceLastUser = false;

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

          const isRework = REWORK_PATTERNS.some(p => p.test(text));
          if (isRework) reworkInstances++;

          // Classify message for sequence analysis.
          // Priority: issue_creation > diagnostic > root_cause_request > rework > other
          const isDiagnostic = DIAGNOSTIC_PATTERNS.some(p => p.test(text));
          const isPivotIssue = PIVOT_PATTERNS.some(p => p.test(text));
          const isPivotRootCause = ROOT_CAUSE_REQUEST_PATTERNS.some(p => p.test(text));

          if (isPivotIssue) {
            messageClasses.push("pivot_issue");
          } else if (isDiagnostic) {
            messageClasses.push("diagnostic");
          } else if (isPivotRootCause) {
            messageClasses.push("pivot_rootcause");
          } else if (isRework) {
            messageClasses.push("rework");
          } else {
            messageClasses.push("other");
          }

          agentActedSinceLastUser = false;
        } else if (msg.type === "assistant") {
          const blocks = msg.message?.content;
          if (!Array.isArray(blocks)) continue;

          for (const block of blocks) {
            if (block?.type !== "tool_use") continue;
            const name: string = block.name || "";
            const input: Record<string, unknown> = block.input || {};

            if (name === "Write" || name === "Edit") {
              const fp = input.file_path;
              if (typeof fp === "string") editedFiles.add(fp);
              agentActedSinceLastUser = true;
            } else if (name === "Bash") {
              const cmd = typeof input.command === "string" ? input.command : "";
              if (GIT_COMMIT_RE.test(cmd)) {
                // Deduplicate commits by issue ref
                const msgMatch = cmd.match(COMMIT_MSG_RE);
                const commitMsg = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? "") : "";
                const refs: string[] = [];
                let refMatch: RegExpExecArray | null;
                const issueRe = new RegExp(ISSUE_REF_RE.source, "g");
                while ((refMatch = issueRe.exec(commitMsg)) !== null) {
                  refs.push(refMatch[1]);
                }

                if (refs.length > 0) {
                  const allSeen = refs.every(r => seenIssueRefs.has(r));
                  if (allSeen) {
                    duplicateCommits++;
                  } else {
                    commits++;
                    for (const r of refs) seenIssueRefs.add(r);
                  }
                } else {
                  commits++;
                }
                agentActedSinceLastUser = true;
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

  const outcomes = editedFiles.size + commits + prs + issues;
  const blindRetries = detectBlindRetries(messageClasses);
  const pivot = detectPivot(messageClasses);

  return { exchanges, reworkInstances, outcomes, duplicateCommits, blindRetries, pivot };
}

/**
 * Detect blind-retry loops: consecutive rework messages without
 * a diagnostic exchange in between. Pivot messages count as rework
 * for chain purposes — the user is still expressing the fix didn't work.
 */
function detectBlindRetries(classes: string[]): number {
  let retries = 0;
  let lastSignificant: string | null = null;

  for (const cls of classes) {
    if (cls === "other") continue;

    const isReworkLike = cls === "rework" || cls === "pivot_issue" || cls === "pivot_rootcause";

    if (isReworkLike && lastSignificant === "rework") {
      retries++;
    }

    lastSignificant = isReworkLike ? "rework" : cls;
  }
  return retries;
}

/**
 * Detect mid-session pivot: user switches from fix attempts to structured debugging.
 * A pivot requires ≥2 fix attempts before the pivot message.
 */
function detectPivot(classes: string[]): PivotSignal | null {
  let fixAttempts = 0;
  let hasRework = false;

  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i];

    if (cls === "rework") {
      hasRework = true;
      fixAttempts++;
    } else if (cls === "other") {
      if (hasRework) fixAttempts++;
    } else if (cls === "pivot_issue" || cls === "pivot_rootcause") {
      if (fixAttempts >= 2) {
        return {
          atExchange: i,
          type: cls === "pivot_issue" ? "issue_creation" : "root_cause_request",
          fixAttemptsBefore: fixAttempts,
        };
      }
    } else if (cls === "diagnostic") {
      fixAttempts = 0;
      hasRework = false;
    }
  }

  return null;
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
