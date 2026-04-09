import { InteractionPatternSignal, HandoffPatternStats, CorrelatedMpgData } from "../types/pulse.js";
import { readFileSync } from "node:fs";

interface SessionMessage {
  type: string;
  message?: { role?: string; content?: unknown };
}

// Directive patterns: imperative, short commands
const DIRECTIVE_PATTERNS = [
  /^(fix|add|remove|delete|create|update|change|move|rename|implement|build|run|deploy|push|merge|revert)\b/i,
  /^do /i,
  /^make /i,
  /^set /i,
  /^use /i,
  /^put /i,
];

// Collaborative patterns: discussion, proposals
const COLLABORATIVE_PATTERNS = [
  /\bwhat if\b/i,
  /\bhow about\b/i,
  /\blet'?s\b/i,
  /\bwe (could|should|might|can)\b/i,
  /\bwhat do you think\b/i,
  /\bi think\b/i,
  /\bmaybe\b/i,
  /\bcould we\b/i,
  /\bshould we\b/i,
  /\balternative/i,
  /\boption/i,
  /\bprefer/i,
];

// Exploratory patterns: questions, investigation
const EXPLORATORY_PATTERNS = [
  /^(why|what|how|where|when|which|can you explain)\b/i,
  /\bexplain\b/i,
  /\bshow me\b/i,
  /\bwhat is\b/i,
  /\bwhat does\b/i,
  /\bhow does\b/i,
  /\bwhy does\b/i,
  /\btell me about\b/i,
  /\bwalk me through\b/i,
  /\bunderstand\b/i,
  /\?$/,
];

// Structured context indicators
const STRUCTURED_PATTERNS = [
  /```/,                       // code blocks
  /#\d+/,                      // issue references
  /https?:\/\//,               // URLs
  /\b[\w/]+\.\w{1,5}:\d+\b/,  // file:line references
  /\b(src|lib|test|bin)\//,    // file paths
  /^\s*-\s+/m,                 // bullet lists
  /^\s*\d+\.\s+/m,            // numbered lists
];

/**
 * Extract interaction pattern signal from a Claude Code session.
 *
 * Classifies:
 * - User style: directive | collaborative | exploratory
 * - Context provision: structured | inline | vague
 * - A qualitative observation about the interaction
 */
export function extractInteractionPattern(
  sessionPath: string | null,
  mpgData?: CorrelatedMpgData | null
): InteractionPatternSignal {
  if (!sessionPath) {
    return {
      userStyle: "directive",
      contextProvision: "vague",
      observation: "No session data available for interaction analysis.",
    };
  }

  const messages = readUserMessages(sessionPath);
  if (messages.length === 0) {
    return {
      userStyle: "directive",
      contextProvision: "vague",
      observation: "No user messages found in session.",
    };
  }

  const userStyle = classifyUserStyle(messages);
  const contextProvision = classifyContextProvision(messages);
  const observation = generateObservation(messages, userStyle, contextProvision);

  const signal: InteractionPatternSignal = { userStyle, contextProvision, observation };

  // Enrich with handoff patterns when MPG data is available
  if (mpgData && mpgData.events.length > 0) {
    const handoffs = computeHandoffPatterns(mpgData);
    if (handoffs) signal.handoffs = handoffs;
  }

  return signal;
}

/**
 * Compute handoff frequency and patterns from MPG agent_handoff events.
 */
export function computeHandoffPatterns(mpgData: CorrelatedMpgData): HandoffPatternStats | null {
  const handoffEvents = mpgData.events.filter(e => e.event_type === "agent_handoff");
  if (handoffEvents.length === 0) return null;

  // Count handoff pairs (prefer new from_agent/to_agent fields, fall back to legacy)
  const pairCounts = new Map<string, { from: string; to: string; count: number }>();
  for (const event of handoffEvents) {
    const from = event.from_agent || event.agent_source || "user";
    const to = event.to_agent || event.agent_target || "unknown";
    const key = `${from}→${to}`;
    const existing = pairCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      pairCounts.set(key, { from, to, count: 1 });
    }
  }

  const handoffPairs = Array.from(pairCounts.values()).sort((a, b) => b.count - a.count);

  // Classify pattern
  const pattern = classifyHandoffPattern(handoffPairs);

  return {
    totalHandoffs: handoffEvents.length,
    handoffPairs,
    pattern,
  };
}

/**
 * Classify handoff pattern:
 * - "single-agent": no handoffs
 * - "pipeline": mostly linear flow (few unique reverse pairs)
 * - "iterative": frequent back-and-forth between agents
 */
function classifyHandoffPattern(
  pairs: Array<{ from: string; to: string; count: number }>
): "pipeline" | "iterative" | "single-agent" {
  if (pairs.length === 0) return "single-agent";

  // Check for reverse pairs (A→B and B→A both exist)
  const pairKeys = new Set(pairs.map(p => `${p.from}→${p.to}`));
  let reversePairCount = 0;
  for (const p of pairs) {
    if (pairKeys.has(`${p.to}→${p.from}`)) reversePairCount++;
  }

  // If >50% of pairs have a reverse, it's iterative
  if (reversePairCount > pairs.length * 0.5) return "iterative";
  return "pipeline";
}

function readUserMessages(sessionPath: string): string[] {
  const messages: string[] = [];
  try {
    const content = readFileSync(sessionPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const msg: SessionMessage = JSON.parse(line);
        if (msg.type !== "user") continue;
        const text = extractText(msg);
        if (text && text.trim().length > 0 && !isSystemMessage(text)) {
          messages.push(text.trim());
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // session file unreadable
  }
  return messages;
}

function classifyUserStyle(
  messages: string[]
): "directive" | "collaborative" | "exploratory" {
  let directiveScore = 0;
  let collaborativeScore = 0;
  let exploratoryScore = 0;

  for (const msg of messages) {
    if (DIRECTIVE_PATTERNS.some(p => p.test(msg))) directiveScore++;
    if (COLLABORATIVE_PATTERNS.some(p => p.test(msg))) collaborativeScore++;
    if (EXPLORATORY_PATTERNS.some(p => p.test(msg))) exploratoryScore++;
  }

  // Tiebreak favors the order: collaborative > exploratory > directive
  if (collaborativeScore >= directiveScore && collaborativeScore >= exploratoryScore) {
    return collaborativeScore > 0 ? "collaborative" : "directive";
  }
  if (exploratoryScore >= directiveScore) {
    return "exploratory";
  }
  return "directive";
}

function classifyContextProvision(
  messages: string[]
): "structured" | "inline" | "vague" {
  let structuredCount = 0;
  const avgLength = messages.reduce((sum, m) => sum + m.length, 0) / messages.length;

  for (const msg of messages) {
    if (STRUCTURED_PATTERNS.some(p => p.test(msg))) {
      structuredCount++;
    }
  }

  const structuredRatio = structuredCount / messages.length;

  // >30% of messages have structured elements → structured
  if (structuredRatio > 0.3) return "structured";
  // Messages are reasonably long (>80 chars avg) → inline context
  if (avgLength > 80) return "inline";
  return "vague";
}

function generateObservation(
  messages: string[],
  style: "directive" | "collaborative" | "exploratory",
  context: "structured" | "inline" | "vague"
): string {
  const avgLength = Math.round(
    messages.reduce((sum, m) => sum + m.length, 0) / messages.length
  );
  const count = messages.length;

  const styleDescriptions = {
    directive: "primarily issuing direct instructions",
    collaborative: "engaging in collaborative discussion with the agent",
    exploratory: "exploring and investigating through questions",
  };

  const contextDescriptions = {
    structured: "with structured context (code blocks, issue refs, file paths)",
    inline: "with inline contextual details",
    vague: "with minimal upfront context",
  };

  return `${count} user messages (avg ${avgLength} chars), ${styleDescriptions[style]} ${contextDescriptions[context]}.`;
}

/** Filter out system/skill messages that have type "user" but aren't human input */
function isSystemMessage(text: string): boolean {
  return (
    text.startsWith("Base directory for this skill:") ||
    text.includes("/.claude/plugins/")
  );
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
