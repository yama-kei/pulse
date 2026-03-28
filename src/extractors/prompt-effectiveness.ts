import {
  PromptEffectivenessSignal,
  PromptEvent,
  EffectivenessScores,
} from "../types/pulse.js";
import { chatCompletion, LlmUnavailableError } from "./llm-client.js";
import { readFileSync } from "node:fs";

interface SessionMessage {
  type: string;
  message?: { role?: string; content?: unknown };
}

const TRACE_EXTRACTION_PROMPT = `You are a prompt effectiveness analyst. Given a sequence of user messages from an AI coding assistant session, extract behavioral events that indicate prompt quality.

For each user message, classify it with one or more of these event types:
- PROVIDED_CONTEXT: User proactively shared relevant files, constraints, error messages, or background
- SCOPED_REQUEST: Clear, bounded instruction with defined success criteria
- VAGUE_REQUEST: Ambiguous instruction that would require the agent to guess intent
- CORRECTED_AGENT: User redirected agent after it went in a wrong direction
- REFINED_INTENT: User clarified or sharpened their goal mid-conversation
- DECOMPOSED_TASK: User broke complex work into discrete, manageable steps
- ACCEPTED_WITHOUT_REVIEW: User accepted agent output without apparent verification
- GAVE_ACTIONABLE_FEEDBACK: Correction included specific, implementable guidance
- GAVE_VAGUE_FEEDBACK: Correction was non-specific ("that's wrong", "try again")
- SCOPE_CREPT: User expanded scope beyond the original stated intent

Rules:
- Use only evidence from the messages. Do not invent events.
- A single message can have multiple events (e.g., PROVIDED_CONTEXT + SCOPED_REQUEST).
- Not every message needs an event — skip messages that are just acknowledgments or status checks.
- Keep reasoning brief (under 15 words).

Respond with JSON: { "events": [{ "messageIndex": number, "eventType": string, "reasoning": string }] }`;

/**
 * Score extracted prompt events into effectiveness dimensions.
 * All scores are 0.0 to 1.0.
 */
export function scoreEvents(
  events: PromptEvent[],
  totalMessages: number
): EffectivenessScores {
  if (totalMessages === 0) {
    return {
      contextProvision: 0,
      scopeDiscipline: 0,
      feedbackQuality: 0,
      decomposition: 0,
      verification: 1, // No messages = nothing to verify
    };
  }

  // Count events by type
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.eventType] = (counts[e.eventType] || 0) + 1;
  }

  const get = (t: string) => counts[t] || 0;

  // Context provision: messages with PROVIDED_CONTEXT / total messages
  const contextProvision = Math.min(get("PROVIDED_CONTEXT") / totalMessages, 1);

  // Scope discipline: scoped / (scoped + vague + scope_crept)
  const scopedTotal =
    get("SCOPED_REQUEST") + get("VAGUE_REQUEST") + get("SCOPE_CREPT");
  const scopeDiscipline =
    scopedTotal > 0 ? get("SCOPED_REQUEST") / scopedTotal : 0;

  // Feedback quality: actionable / (actionable + vague)
  const feedbackTotal =
    get("GAVE_ACTIONABLE_FEEDBACK") + get("GAVE_VAGUE_FEEDBACK");
  const feedbackQuality =
    feedbackTotal > 0 ? get("GAVE_ACTIONABLE_FEEDBACK") / feedbackTotal : 0;

  // Decomposition: presence of DECOMPOSED_TASK in sessions with >3 messages
  const decomposition =
    totalMessages > 3
      ? Math.min(get("DECOMPOSED_TASK") / Math.ceil(totalMessages / 5), 1)
      : get("DECOMPOSED_TASK") > 0
        ? 1
        : 0;

  // Verification: inverse of uncritical acceptance rate
  const verification =
    totalMessages > 0
      ? 1 - Math.min(get("ACCEPTED_WITHOUT_REVIEW") / totalMessages, 1)
      : 1;

  return {
    contextProvision: round(contextProvision),
    scopeDiscipline: round(scopeDiscipline),
    feedbackQuality: round(feedbackQuality),
    decomposition: round(decomposition),
    verification: round(verification),
  };
}

/** Weighted overall score from dimension scores */
function computeOverall(scores: EffectivenessScores): number {
  const weights = {
    contextProvision: 0.25,
    scopeDiscipline: 0.30,
    feedbackQuality: 0.20,
    decomposition: 0.10,
    verification: 0.15,
  };
  const total =
    scores.contextProvision * weights.contextProvision +
    scores.scopeDiscipline * weights.scopeDiscipline +
    scores.feedbackQuality * weights.feedbackQuality +
    scores.decomposition * weights.decomposition +
    scores.verification * weights.verification;
  return round(total);
}

/** Map overall score to human label */
export function rateOverall(
  score: number
): "excellent" | "good" | "moderate" | "developing" {
  if (score >= 0.75) return "excellent";
  if (score >= 0.55) return "good";
  if (score >= 0.35) return "moderate";
  return "developing";
}

/** Generate observation from scores and events */
function generateObservation(
  scores: EffectivenessScores,
  events: PromptEvent[],
  totalMessages: number
): string {
  const parts: string[] = [];

  if (scores.contextProvision >= 0.5) {
    parts.push("strong context provision");
  } else if (scores.contextProvision < 0.2 && totalMessages > 2) {
    parts.push("limited upfront context");
  }

  if (scores.scopeDiscipline >= 0.7) {
    parts.push("well-scoped requests");
  } else if (scores.scopeDiscipline < 0.3) {
    parts.push("requests could be more specific");
  }

  const corrections =
    events.filter((e) => e.eventType === "CORRECTED_AGENT").length;
  if (corrections > totalMessages * 0.3) {
    parts.push("frequent corrections suggest initial prompts may need more detail");
  }

  if (parts.length === 0) {
    return `${totalMessages} messages analyzed — mixed effectiveness signals.`;
  }
  return `${totalMessages} messages analyzed — ${parts.join("; ")}.`;
}

const COACHING_TIPS: Record<keyof EffectivenessScores, string> = {
  contextProvision:
    "Share relevant files, error messages, or constraints upfront — agents work better with concrete context than abstract descriptions.",
  scopeDiscipline:
    "Define clear boundaries for each request. Instead of 'fix the app', try 'fix the login validation error in auth.ts — it should reject empty passwords'.",
  feedbackQuality:
    "When correcting the agent, be specific about what's wrong and what you want instead. 'Move the validation to the controller' is better than 'that's not right'.",
  decomposition:
    "Break complex tasks into smaller steps. Give the agent one clear objective at a time rather than a multi-part request.",
  verification:
    "Review agent output before accepting — check that code compiles, tests pass, and behavior matches your intent.",
};

export function generateCoaching(scores: EffectivenessScores): string[] {
  const weak = (Object.keys(COACHING_TIPS) as (keyof EffectivenessScores)[])
    .filter((dim) => scores[dim] < 0.5)
    .sort((a, b) => scores[a] - scores[b]);

  if (weak.length === 0) {
    return ["Strong prompting across all dimensions — keep it up."];
  }

  return weak.slice(0, 3).map((dim) => COACHING_TIPS[dim]);
}

/**
 * Extract prompt effectiveness signal from a Claude Code session.
 * Stage 1: LLM extracts behavioral events from user messages.
 * Stage 2: Deterministic scoring from events.
 * Degrades gracefully when no API key or session file is available.
 */
export async function extractPromptEffectiveness(
  sessionPath: string | null
): Promise<PromptEffectivenessSignal> {
  const unavailable: PromptEffectivenessSignal = {
    available: false,
    events: [],
    scores: {
      contextProvision: 0,
      scopeDiscipline: 0,
      feedbackQuality: 0,
      decomposition: 0,
      verification: 0,
    },
    overallScore: 0,
    rating: "developing",
    observation: "Prompt effectiveness evaluation unavailable.",
    coaching: [],
  };

  if (!sessionPath) return unavailable;

  const messages = readUserMessages(sessionPath);
  if (messages.length === 0) return unavailable;

  // Stage 1: LLM trace extraction
  let events: PromptEvent[];
  try {
    events = await extractTrace(messages);
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      process.stderr.write(`Warning: ${err.message}\n`);
      return unavailable;
    }
    throw err;
  }

  // Stage 2: Deterministic scoring
  const scores = scoreEvents(events, messages.length);
  const overallScore = computeOverall(scores);
  const rating = rateOverall(overallScore);
  const observation = generateObservation(scores, events, messages.length);
  const coaching = generateCoaching(scores);

  return {
    available: true,
    events,
    scores,
    overallScore,
    rating,
    observation,
    coaching,
  };
}

/** Stage 1: Send user messages to LLM for behavioral event extraction */
async function extractTrace(messages: string[]): Promise<PromptEvent[]> {
  const numberedMessages = messages
    .map((m, i) => `[${i}] ${m}`)
    .join("\n\n");

  process.stderr.write(
    `Calling GPT-4o for prompt effectiveness analysis (${messages.length} messages)...\n`
  );

  const response = await chatCompletion(
    "gpt-4o",
    [
      { role: "system", content: TRACE_EXTRACTION_PROMPT },
      { role: "user", content: numberedMessages },
    ],
    { temperature: 0, timeout: 60000 }
  );

  let parsed: any;
  try {
    parsed = JSON.parse(response);
  } catch {
    process.stderr.write(
      `Warning: GPT-4o response was not valid JSON (${response.length} chars). Skipping prompt effectiveness.\n`
    );
    return [];
  }
  if (!Array.isArray(parsed.events)) {
    process.stderr.write(
      `Warning: GPT-4o response missing "events" array. Skipping prompt effectiveness.\n`
    );
    return [];
  }

  // Validate and filter events
  const validTypes = new Set([
    "PROVIDED_CONTEXT",
    "SCOPED_REQUEST",
    "VAGUE_REQUEST",
    "CORRECTED_AGENT",
    "REFINED_INTENT",
    "DECOMPOSED_TASK",
    "ACCEPTED_WITHOUT_REVIEW",
    "GAVE_ACTIONABLE_FEEDBACK",
    "GAVE_VAGUE_FEEDBACK",
    "SCOPE_CREPT",
  ]);

  const validated = parsed.events.filter(
    (e: any) =>
      typeof e.messageIndex === "number" &&
      typeof e.eventType === "string" &&
      validTypes.has(e.eventType) &&
      e.messageIndex >= 0 &&
      e.messageIndex < messages.length
  );

  const dropped = parsed.events.length - validated.length;
  if (dropped > 0) {
    process.stderr.write(
      `Warning: ${dropped}/${parsed.events.length} GPT-4o events failed validation and were dropped.\n`
    );
  }

  return validated;
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

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
