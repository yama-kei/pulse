import { IntentAnchoringSignal, IntentSummary, IntentLayerCheckResult } from "../types/pulse.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Extract intent anchoring signal from the project directory.
 *
 * Reads INTENTS.md and CLAUDE.md if present.
 * Runs `intentlayer check --json` if available.
 * Compares declared intents against recent commit messages.
 */
export function extractIntentAnchoring(
  projectDir: string,
  commitMessages: string[]
): IntentAnchoringSignal {
  const intentsPath = join(projectDir, "INTENTS.md");
  const claudeMdPath = join(projectDir, "CLAUDE.md");

  const intentsPresent = existsSync(intentsPath);
  const claudeMdPresent = existsSync(claudeMdPath);

  const declaredIntents = intentsPresent ? parseIntentsMd(intentsPath) : [];
  const intentLayerCheck = runIntentLayerCheck(projectDir);

  // Find which intent IDs appear in commit messages
  const allIntentIds = declaredIntents.map(i => i.id);
  const referencedIntents = allIntentIds.filter(id =>
    commitMessages.some(msg => msg.includes(id))
  );

  // For now, mark all declared intents as "relevant" — semantic matching
  // of intent goals against changed files requires LLM and comes in a later phase.
  // This is a conservative default: if intents exist and aren't referenced, flag them.
  const relevantIntents = allIntentIds;
  const gap = relevantIntents.filter(id => !referencedIntents.includes(id));

  return {
    intentsPresent,
    claudeMdPresent,
    declaredIntents,
    relevantIntents,
    referencedIntents,
    gap,
    intentLayerCheck,
  };
}

const INTENT_HEADING_RE = /^##\s+(I-\d{3})[:.]?\s*(.*)/;
const HEALTH_RE = /\*?\*?Current Health\*?\*?\s*\n([^\n]*)/;
const HEALTH_EMOJI_RE = /(🟢|🟡|🔴)\s*(.*)/;

function parseIntentsMd(filePath: string): IntentSummary[] {
  const content = readFileSync(filePath, "utf-8");
  const intents: IntentSummary[] = [];

  const sections = content.split(/(?=^## I-\d{3})/m);
  for (const section of sections) {
    const headingMatch = section.match(INTENT_HEADING_RE);
    if (!headingMatch) continue;

    const id = headingMatch[1];
    const title = headingMatch[2].trim();

    let health = "unknown";
    const healthSection = section.match(HEALTH_RE);
    if (healthSection) {
      const emojiMatch = healthSection[1].match(HEALTH_EMOJI_RE);
      if (emojiMatch) {
        health = emojiMatch[2].trim() || emojiMatch[1];
      }
    }

    intents.push({ id, title, health });
  }

  return intents;
}

function runIntentLayerCheck(projectDir: string): IntentLayerCheckResult | null {
  try {
    const result = execSync("npx --yes intentlayer check --json", {
      cwd: projectDir,
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });
    return JSON.parse(result.trim());
  } catch {
    return null;
  }
}
