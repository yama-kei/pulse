import { DecisionEvent, DecisionEventType, DecisionEventsSignal } from "../types/pulse.js";
import { readFileSync } from "node:fs";

/** A single file interaction extracted from tool-use blocks */
interface FileTouch {
  action: "read" | "grep" | "edit" | "write" | "commit" | "pr" | "issue";
  file: string;
  timestamp: string;
  /** Cumulative tokens at this point in the session */
  cumulativeTokens: number;
  /** Commit message text (only for action=commit) */
  commitMessage?: string;
}

/**
 * Extract decision events from a Claude Code session JSONL file.
 *
 * Builds a timeline of file touches from tool-use blocks, then applies
 * heuristic patterns to detect moments where uncertainty was resolved.
 */
export function extractDecisionEvents(
  sessionPath: string | null,
  totalTokens: number
): DecisionEventsSignal {
  const empty: DecisionEventsSignal = {
    events: [],
    decisionCount: 0,
    tokensPerDecision: 0,
    available: false,
  };

  if (!sessionPath) return empty;

  let timeline: FileTouch[];
  try {
    timeline = buildTimeline(sessionPath);
  } catch {
    return empty;
  }

  if (timeline.length === 0) return empty;

  const events = detectEvents(timeline);

  // Assign tokensCost: tokens consumed since previous decision event
  assignTokenCosts(events, totalTokens);

  const decisionCount = events.length;
  const tokensPerDecision = decisionCount > 0 ? Math.round(totalTokens / decisionCount) : 0;

  return {
    events,
    decisionCount,
    tokensPerDecision,
    available: true,
  };
}

/** Parse session JSONL into a chronological timeline of file touches */
function buildTimeline(sessionPath: string): FileTouch[] {
  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const timeline: FileTouch[] = [];
  let cumulativeTokens = 0;

  for (const line of lines) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = msg.timestamp || "";

    // Accumulate tokens from assistant messages
    if (msg.message?.role === "assistant" && msg.message?.usage) {
      cumulativeTokens += (msg.message.usage.input_tokens ?? 0) + (msg.message.usage.output_tokens ?? 0);
    }

    // Extract tool-use blocks from assistant messages
    if (msg.type !== "assistant") continue;
    const blocks = msg.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block?.type !== "tool_use") continue;

      const name: string = block.name || "";
      const input: Record<string, unknown> = block.input || {};

      if (name === "Read") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "read", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Grep") {
        const path = typeof input.path === "string" ? input.path : "";
        timeline.push({ action: "grep", file: path || "(cwd)", timestamp, cumulativeTokens });
      } else if (name === "Edit") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "edit", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Write") {
        const fp = typeof input.file_path === "string" ? input.file_path : "";
        if (fp) timeline.push({ action: "write", file: fp, timestamp, cumulativeTokens });
      } else if (name === "Bash") {
        const cmd = typeof input.command === "string" ? input.command : "";
        if (/\bgit\s+commit\b/.test(cmd)) {
          const msgMatch = cmd.match(/-m\s+(?:"([^"]*?)"|'([^']*?)')/);
          const commitMsg = msgMatch ? (msgMatch[1] ?? msgMatch[2] ?? "") : "";
          timeline.push({ action: "commit", file: "", timestamp, cumulativeTokens, commitMessage: commitMsg });
        }
        if (/\bgh\s+pr\s+create\b/.test(cmd)) {
          timeline.push({ action: "pr", file: "", timestamp, cumulativeTokens });
        }
        if (/\bgh\s+issue\s+create\b/.test(cmd)) {
          timeline.push({ action: "issue", file: "", timestamp, cumulativeTokens });
        }
      }
    }
  }

  return timeline;
}

/** Apply heuristic rules over the timeline to detect decision events */
function detectEvents(timeline: FileTouch[]): DecisionEvent[] {
  const events: DecisionEvent[] = [];
  const commitIndices: number[] = [];

  // Index commits for quick lookup
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].action === "commit") commitIndices.push(i);
  }

  // Rule 1: feature_shipped — feat: commit + PR
  // Rule 2: bug_resolved — fix: commit + issue ref
  // Rule 3: root_cause_identified — exploration → fix: commit
  // Rule 4: implementation_decided — reads/edits → commit (no rework)
  // Rule 5: schema_locked — file edited then untouched for rest of session
  // Rule 6: design_chosen — reads across multiple files → single path committed

  const usedCommits = new Set<number>();

  // Pass 1: Commit-based events (highest confidence first)
  for (const ci of commitIndices) {
    const touch = timeline[ci];
    const msg = touch.commitMessage || "";

    // feature_shipped: feat: commit near a PR
    if (/^feat[:(]/i.test(msg)) {
      const hasPR = timeline.slice(ci, Math.min(ci + 5, timeline.length)).some(t => t.action === "pr");
      if (hasPR) {
        events.push({
          type: "feature_shipped",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
        continue;
      }
    }

    // bug_resolved: fix: commit + issue ref
    if (/^fix[:(]/i.test(msg) && /#\d+/.test(msg)) {
      events.push({
        type: "bug_resolved",
        timestamp: touch.timestamp,
        confidence: "high",
        relatedFiles: collectRelatedFiles(timeline, ci),
        tokensCost: 0,
      });
      usedCommits.add(ci);
      continue;
    }

    // root_cause_identified: exploration phase (reads/greps) → fix: commit
    if (/^fix[:(]/i.test(msg) && !usedCommits.has(ci)) {
      const priorActions = timeline.slice(Math.max(0, ci - 10), ci);
      const reads = priorActions.filter(t => t.action === "read" || t.action === "grep").length;
      if (reads >= 2) {
        events.push({
          type: "root_cause_identified",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
        continue;
      }
    }

    // implementation_decided: edits → commit (generic)
    if (!usedCommits.has(ci)) {
      const priorActions = timeline.slice(Math.max(0, ci - 10), ci);
      const hasEdits = priorActions.some(t => t.action === "edit" || t.action === "write");
      if (hasEdits) {
        events.push({
          type: "implementation_decided",
          timestamp: touch.timestamp,
          confidence: "high",
          relatedFiles: collectRelatedFiles(timeline, ci),
          tokensCost: 0,
        });
        usedCommits.add(ci);
      }
    }
  }

  // Pass 2: schema_locked — files edited early, untouched in second half
  const midpoint = Math.floor(timeline.length / 2);
  if (midpoint > 0) {
    const editedFirstHalf = new Set<string>();
    const touchedSecondHalf = new Set<string>();

    for (let i = 0; i < midpoint; i++) {
      const t = timeline[i];
      if (t.action === "edit" || t.action === "write") editedFirstHalf.add(t.file);
    }
    for (let i = midpoint; i < timeline.length; i++) {
      const t = timeline[i];
      if (t.action === "edit" || t.action === "write" || t.action === "read") touchedSecondHalf.add(t.file);
    }

    for (const file of editedFirstHalf) {
      if (!touchedSecondHalf.has(file)) {
        // Find the last edit of this file
        let lastEditIdx = -1;
        for (let i = midpoint - 1; i >= 0; i--) {
          if ((timeline[i].action === "edit" || timeline[i].action === "write") && timeline[i].file === file) {
            lastEditIdx = i;
            break;
          }
        }
        if (lastEditIdx >= 0) {
          events.push({
            type: "schema_locked",
            timestamp: timeline[lastEditIdx].timestamp,
            confidence: "medium",
            relatedFiles: [file],
            tokensCost: 0,
          });
        }
      }
    }
  }

  // Pass 3: design_chosen — many reads across different files → single path committed
  for (const ci of commitIndices) {
    if (usedCommits.has(ci)) continue;
    const window = timeline.slice(Math.max(0, ci - 15), ci);
    const readFiles = new Set(window.filter(t => t.action === "read").map(t => t.file));
    const editFiles = new Set(window.filter(t => t.action === "edit" || t.action === "write").map(t => t.file));
    if (readFiles.size >= 3 && editFiles.size <= 2 && editFiles.size > 0) {
      events.push({
        type: "design_chosen",
        timestamp: timeline[ci].timestamp,
        confidence: "medium",
        relatedFiles: [...editFiles],
        tokensCost: 0,
      });
    }
  }

  // Sort by timestamp
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return events;
}

/** Collect files that were edited/written in the window before a commit */
function collectRelatedFiles(timeline: FileTouch[], commitIdx: number): string[] {
  const files = new Set<string>();
  for (let i = Math.max(0, commitIdx - 10); i < commitIdx; i++) {
    const t = timeline[i];
    if ((t.action === "edit" || t.action === "write") && t.file) {
      files.add(t.file);
    }
  }
  return [...files];
}

/** Assign tokensCost to each event: tokens consumed since previous event */
function assignTokenCosts(events: DecisionEvent[], totalTokens: number): void {
  if (events.length === 0) return;

  // Simple proportional distribution: totalTokens / eventCount
  // (More precise tracking would require correlating events back to timeline positions,
  // but this is sufficient for the first cut)
  const perEvent = Math.round(totalTokens / events.length);
  for (const event of events) {
    event.tokensCost = perEvent;
  }
}
