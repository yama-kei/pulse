import { DecisionQualitySignal } from "../types/pulse.js";
import { execSync } from "node:child_process";

/**
 * Extract decision quality signal from recent git history.
 *
 * Analyzes commit messages for:
 * - "Why" language (because, so that, to prevent, in order to)
 * - Issue references (#N)
 * - Conventional commit prefixes
 */
export function extractDecisionQuality(
  projectDir: string,
  since?: string
): DecisionQualitySignal {
  const commitMessages = getRecentCommits(projectDir, since);
  return scoreCommitMessages(commitMessages);
}

/**
 * Score commit messages for decision quality signals.
 * Exported for testing — called by extractDecisionQuality with git-derived messages.
 */
export function scoreCommitMessages(commitMessages: string[]): DecisionQualitySignal {
  const commitsTotal = commitMessages.length;

  const commitsWithWhy = commitMessages.filter(msg =>
    WHY_PATTERNS.some(p => p.test(msg)) ||
    CONVENTIONAL_PREFIX_RE.test(msg) ||
    ISSUE_REF_RE.test(msg)
  ).length;

  const commitsWithIssueRef = commitMessages.filter(msg =>
    ISSUE_REF_RE.test(msg)
  ).length;

  return {
    commitsTotal,
    commitsWithWhy,
    commitsWithIssueRef,
    externalContextProvided: false,
    commitMessages,
  };
}

/** Explicit why-language patterns */
const WHY_PATTERNS = [
  /\bbecause\b/i,
  /\bso that\b/i,
  /\bto prevent\b/i,
  /\bin order to\b/i,
  /\bto avoid\b/i,
  /\bto ensure\b/i,
  /\bto fix\b/i,
  /\bto resolve\b/i,
  /\bto support\b/i,
  /\bto enable\b/i,
  /\bneeded for\b/i,
  /\brequired by\b/i,
  /\baddresses\b/i,
  /\bcloses\b/i,
  /\bfixes\b/i,
  /\bresolves\b/i,
];

/** Conventional commit prefixes convey intent implicitly */
const CONVENTIONAL_PREFIX_RE = /^(feat|fix|refactor|docs|test|chore|perf|ci|build|style|revert)(\(.+?\))?:/i;

const ISSUE_REF_RE = /#\d+/;

function getRecentCommits(projectDir: string, since?: string): string[] {
  try {
    const sinceArg = since ? `--since="${since}"` : "-20";
    const result = execSync(`git log ${sinceArg} --format="%s%n%b" --no-merges`, {
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return result
      .split("\n\n")
      .map(m => m.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
