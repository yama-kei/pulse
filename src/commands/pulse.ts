import { PulseReport } from "../types/pulse.js";
import { extractConvergence, findSessionFile } from "../extractors/convergence.js";
import { extractIntentAnchoring } from "../extractors/intent-anchoring.js";
import { extractDecisionQuality } from "../extractors/decision-quality.js";
import { extractInteractionPattern } from "../extractors/interaction-pattern.js";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export function runPulse(projectDir: string): PulseReport {
  const project = basename(projectDir);
  const filesChanged = countFilesChanged(projectDir);
  const sessionFile = findSessionFile(projectDir);
  const convergence = extractConvergence(sessionFile, filesChanged);
  const decisionQuality = extractDecisionQuality(projectDir);
  const intentAnchoring = extractIntentAnchoring(projectDir, decisionQuality.commitMessages);
  const interactionPattern = extractInteractionPattern(sessionFile);
  const interactionLeverage = computeLeverage(convergence, decisionQuality);

  return {
    timestamp: new Date().toISOString(),
    project,
    cwd: projectDir,
    convergence,
    intentAnchoring,
    decisionQuality,
    interactionPattern,
    interactionLeverage,
  };
}

export function formatReport(report: PulseReport): string {
  const { convergence: c, intentAnchoring: ia, decisionQuality: dq, interactionPattern: ip } = report;

  const lines: string[] = [];
  const hr = "─".repeat(50);

  lines.push(`Pulse — ${report.project}`);
  lines.push("═".repeat(50));
  lines.push(`${report.timestamp} | ${c.exchanges} exchanges | ${c.outcomes} outcomes`);
  lines.push("");

  // Convergence
  lines.push("CONVERGENCE");
  lines.push(`  Exchanges to outcome:  ${c.rate} (${rateLabel(c.rate)})`);
  lines.push(`  Rework instances:      ${c.reworkInstances} (${c.reworkPercent}%)`);
  lines.push("");

  // Intent Anchoring
  lines.push("INTENT ANCHORING");
  lines.push(`  INTENTS.md:            ${ia.intentsPresent ? "present" : "absent"}`);
  lines.push(`  CLAUDE.md:             ${ia.claudeMdPresent ? "present" : "absent"}`);
  if (ia.intentsPresent) {
    lines.push(`  Declared intents:      ${ia.declaredIntents.length}`);
    for (const intent of ia.declaredIntents) {
      lines.push(`    ${intent.id}: ${intent.title} [${intent.health}]`);
    }
    lines.push(`  Referenced in commits: ${ia.referencedIntents.length > 0 ? ia.referencedIntents.join(", ") : "none"}`);
    if (ia.gap.length > 0) {
      lines.push(`  Gap:                   ${ia.gap.join(", ")} declared but not referenced`);
    }
  }
  if (ia.intentLayerCheck) {
    const ilc = ia.intentLayerCheck;
    lines.push(`  IntentLayer check:     ${ilc.status} — ${ilc.intents} intents, ${ilc.commitCoverage.percent}% commit coverage`);
  }
  lines.push("");

  // Decision Quality
  lines.push("DECISION QUALITY");
  lines.push(`  Commits:               ${dq.commitsTotal}`);
  lines.push(`  Reference "why":       ${dq.commitsWithWhy}/${dq.commitsTotal}`);
  lines.push(`  Link to issues:        ${dq.commitsWithIssueRef}/${dq.commitsTotal}`);
  lines.push("");

  // Interaction Pattern
  lines.push("INTERACTION PATTERN");
  lines.push(`  User style:            ${ip.userStyle}`);
  lines.push(`  Context provision:     ${ip.contextProvision}`);
  lines.push(`  ${ip.observation}`);
  lines.push("");

  // Summary
  lines.push(hr);
  lines.push(`Interaction Leverage:    ${report.interactionLeverage}`);
  lines.push(hr);

  // Actionable nudges
  const nudges = generateNudges(report);
  if (nudges.length > 0) {
    lines.push("");
    lines.push("OBSERVATIONS");
    for (const nudge of nudges) {
      lines.push(`  - ${nudge}`);
    }
  }

  return lines.join("\n");
}

export function savePulse(projectDir: string, report: PulseReport): string {
  const apoDir = join(projectDir, ".pulse");
  if (!existsSync(apoDir)) {
    mkdirSync(apoDir, { recursive: true });
  }
  const filename = `pulse-${report.timestamp.replace(/[:.]/g, "-")}.json`;
  const filePath = join(apoDir, filename);
  writeFileSync(filePath, JSON.stringify(report, null, 2) + "\n");
  return filePath;
}

function countFilesChanged(projectDir: string): number {
  try {
    const result = execSync("git diff --stat HEAD~5 HEAD --name-only 2>/dev/null | wc -l", {
      cwd: projectDir,
      timeout: 5000,
      encoding: "utf-8",
    });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function computeLeverage(
  convergence: PulseReport["convergence"],
  decisionQuality: PulseReport["decisionQuality"]
): "HIGH" | "MEDIUM" | "LOW" {
  const { rate, reworkPercent } = convergence;

  // HIGH: <=1 exchange per outcome, <10% rework
  if (rate <= 1 && reworkPercent < 10) return "HIGH";
  // LOW: >4 exchanges per outcome or >15% rework
  if (rate > 4 || reworkPercent > 15) return "LOW";
  return "MEDIUM";
}

function rateLabel(rate: number): string {
  if (rate <= 0.5) return "excellent";
  if (rate <= 1.5) return "good";
  if (rate <= 4) return "moderate";
  return "high — consider clearer problem framing";
}

function generateNudges(report: PulseReport): string[] {
  const nudges: string[] = [];
  const { convergence: c, intentAnchoring: ia, decisionQuality: dq, interactionPattern: ip } = report;

  if (!ia.intentsPresent && !ia.claudeMdPresent) {
    nudges.push("No INTENTS.md or CLAUDE.md found. Consider adding project constraints to anchor AI work.");
  }

  if (ia.intentsPresent && ia.gap.length > 0) {
    nudges.push(`${ia.gap.length} intent(s) declared but not referenced in commits: ${ia.gap.join(", ")}. Consider reviewing intent alignment.`);
  }

  if (ia.intentLayerCheck && ia.intentLayerCheck.commitCoverage.percent < 20) {
    nudges.push(`Only ${ia.intentLayerCheck.commitCoverage.percent}% of commits reference intent IDs. Low coverage may indicate intent drift.`);
  }

  if (dq.commitsTotal > 0 && dq.commitsWithWhy === 0) {
    nudges.push("No commits explain \"why\" — only \"what\". Commit messages that capture reasoning improve future maintainability.");
  }

  if (c.reworkPercent > 15) {
    nudges.push(`${c.reworkPercent}% rework rate. Consider providing more structured context upfront to reduce back-and-forth.`);
  }

  if (c.rate > 4) {
    nudges.push(`${c.rate} exchanges per outcome is high. Pre-loading decisions (in issues, specs, or CLAUDE.md) can improve convergence.`);
  }

  return nudges;
}
