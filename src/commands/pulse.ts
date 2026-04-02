import { PulseReport, AgentReport, ThreadPulseReport, DecisionEventsSignal } from "../types/pulse.js";
import { extractConvergence, findSessionFile, extractSessionTimeWindow, SessionTimeWindow } from "../extractors/convergence.js";
import { extractIntentAnchoring } from "../extractors/intent-anchoring.js";
import { extractDecisionQuality } from "../extractors/decision-quality.js";
import { extractTokenUsage } from "../extractors/token-usage.js";
import { extractDecisionEvents } from "../extractors/decision-events.js";
import { extractInteractionPattern } from "../extractors/interaction-pattern.js";
import { extractPromptEffectiveness } from "../extractors/prompt-effectiveness.js";
import { correlateMpgEvents } from "../activity/mpg-correlator.js";
import { loadReports } from "./history.js";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export async function runPulse(projectDir: string, sessionPath?: string): Promise<PulseReport> {
  const project = basename(projectDir);
  const sessionFile = sessionPath ?? findSessionFile(projectDir);
  const timeWindow = extractSessionTimeWindow(sessionFile);
  const filesChanged = countFilesChanged(projectDir, timeWindow);
  const mpgData = correlateMpgEvents(sessionFile);
  const convergence = extractConvergence(sessionFile, filesChanged, mpgData);
  const decisionQuality = extractDecisionQuality(projectDir);
  const intentAnchoring = extractIntentAnchoring(projectDir, decisionQuality.commitMessages);
  const tokenUsage = extractTokenUsage(sessionFile, convergence.exchanges, convergence.outcomes);
  const decisionEvents = extractDecisionEvents(sessionFile, tokenUsage.totalTokens);
  const interactionPattern = extractInteractionPattern(sessionFile, mpgData);
  const promptEffectiveness = await extractPromptEffectiveness(sessionFile);
  const { score: leverageScore, label: interactionLeverage } = computeLeverage(convergence, decisionQuality);

  return {
    timestamp: new Date().toISOString(),
    project,
    cwd: projectDir,
    convergence,
    intentAnchoring,
    decisionQuality,
    tokenUsage,
    decisionEvents,
    interactionPattern,
    promptEffectiveness,
    interactionLeverage,
    leverageScore,
  };
}

export function formatReport(report: PulseReport): string {
  const { convergence: c, intentAnchoring: ia, decisionQuality: dq, tokenUsage: tu, interactionPattern: ip } = report;

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
  if (c.blindRetries > 0) {
    lines.push(`  Blind retries:         ${c.blindRetries}`);
  }
  if (c.pivot) {
    const pivotLabel = c.pivot.type === "issue_creation" ? "issue creation" : "root cause investigation";
    lines.push(`  Pivot detected:        → ${pivotLabel} at exchange ${c.pivot.atExchange + 1} (after ${c.pivot.fixAttemptsBefore} fix attempts)`);
  }
  if (c.agentBreakdown && c.agentBreakdown.length > 0) {
    lines.push("  Per-agent breakdown:");
    for (const a of c.agentBreakdown) {
      const penaltyNote = a.convergencePenalty > 0 ? ` (+${a.convergencePenalty} penalty)` : "";
      lines.push(`    ${a.agent.padEnd(16)} ${a.messages} msgs, ${a.errors} errors (${a.errorRate}%)${penaltyNote}`);
    }
  }
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

  // Token Correlation (only if data available)
  if (tu.available) {
    lines.push("TOKEN CORRELATION");
    lines.push(`  Tokens per exchange:   ${tu.tokensPerExchange.toLocaleString()}`);
    lines.push(`  Tokens per outcome:    ${tu.tokensPerOutcome.toLocaleString()}`);
    lines.push("");
  }

  // Decision Events
  const de = report.decisionEvents;
  if (de.available) {
    lines.push("DECISION EVENTS");
    lines.push(`  Decisions detected:    ${de.decisionCount}`);
    if (de.tokensPerDecision > 0) {
      lines.push(`  Tokens per decision:   ${de.tokensPerDecision.toLocaleString()}`);
    }
    if (de.events.length > 0) {
      for (const event of de.events) {
        const files = event.relatedFiles.length > 0 ? ` (${event.relatedFiles.join(", ")})` : "";
        lines.push(`    ${event.type} [${event.confidence}]${files}`);
      }
    }
    lines.push("");
  }

  // Interaction Pattern
  lines.push("INTERACTION PATTERN");
  lines.push(`  User style:            ${ip.userStyle}`);
  lines.push(`  Context provision:     ${ip.contextProvision}`);
  lines.push(`  ${ip.observation}`);
  if (ip.handoffs) {
    const h = ip.handoffs;
    lines.push(`  Handoff pattern:       ${h.pattern} (${h.totalHandoffs} handoffs)`);
    for (const pair of h.handoffPairs) {
      lines.push(`    ${pair.from} → ${pair.to}: ${pair.count}x`);
    }
  }
  lines.push("");

  // Prompt Effectiveness
  if (report.promptEffectiveness.available) {
    const pe = report.promptEffectiveness;
    const history = loadHistoricalScores(report.cwd, report.timestamp);
    lines.push("PROMPT EFFECTIVENESS");
    lines.push(`  Overall:               ${pe.overallScore} (${pe.rating})`);

    const dims: Array<[string, keyof typeof pe.scores]> = [
      ["Context provision", "contextProvision"],
      ["Scope discipline", "scopeDiscipline"],
      ["Feedback quality", "feedbackQuality"],
      ["Decomposition", "decomposition"],
      ["Verification", "verification"],
    ];
    for (const [label, key] of dims) {
      const delta = history ? formatDelta(pe.scores[key], history.avgScores[key]) : "";
      lines.push(`  ${label.padEnd(21)}${pe.scores[key]}${delta}`);
    }

    lines.push(`  ${pe.observation}`);

    if (history && history.count >= 2) {
      lines.push("");
      const dir = history.overallTrend > 0 ? "improving" : history.overallTrend < 0 ? "declining" : "stable";
      lines.push(`  Trend: ${history.firstOverall.toFixed(2)} → ${pe.overallScore.toFixed(2)} over last ${history.count} sessions (${dir})`);
    }

    if (pe.coaching.length > 0) {
      lines.push("");
      lines.push("  Tips:");
      for (const tip of pe.coaching) {
        lines.push(`  → ${tip}`);
      }
    }
    lines.push("");
  }

  // Summary
  lines.push(hr);
  lines.push(`Interaction Leverage:    ${report.leverageScore.toFixed(2)} (${report.interactionLeverage})`);
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

function countFilesChanged(projectDir: string, timeWindow: SessionTimeWindow): number {
  try {
    let cmd: string;
    if (timeWindow.start && timeWindow.end) {
      // Scope to the session's time window — count unique files changed in commits during that period
      // Use --since (inclusive) and pad end time by 1 minute to avoid cutting off final commits
      const endPadded = new Date(new Date(timeWindow.end).getTime() + 60000).toISOString();
      cmd = `git log --since="${timeWindow.start}" --until="${endPadded}" --name-only --pretty=format: 2>/dev/null | sort -u | grep -c .`;
    } else {
      // Fallback: last 5 commits
      cmd = "git diff HEAD~5 HEAD --name-only 2>/dev/null | wc -l";
    }
    const result = execSync(cmd, {
      cwd: projectDir,
      timeout: 5000,
      encoding: "utf-8",
    });
    return parseInt(result.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function computeLeverage(
  convergence: PulseReport["convergence"],
  decisionQuality: PulseReport["decisionQuality"]
): { score: number; label: "HIGH" | "MEDIUM" | "LOW" } {
  const { rate, reworkPercent, blindRetries } = convergence;
  const { commitsTotal, commitsWithWhy, commitsWithIssueRef } = decisionQuality;

  // Outcome Quality: commit message quality (why + issue refs)
  const outcomeQuality = commitsTotal > 0
    ? (commitsWithWhy / commitsTotal) * 0.5 + (commitsWithIssueRef / commitsTotal) * 0.5
    : 0;

  // Efficiency: inverse of convergence rate (lower rate = higher efficiency)
  const efficiency = 1 / (1 + rate);

  // Stability: inverse of rework percentage
  const stability = 1 - (reworkPercent / 100);

  // Blind-retry penalty: each blind retry reduces score
  const retryPenalty = Math.min(blindRetries * 0.1, 0.3);

  // Equal weight blend, clamped to [0, 1]
  const raw = (outcomeQuality + efficiency + stability) / 3 - retryPenalty;
  const score = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;

  // Derive label from score thresholds
  const label: "HIGH" | "MEDIUM" | "LOW" = score >= 0.7 ? "HIGH" : score >= 0.4 ? "MEDIUM" : "LOW";

  return { score, label };
}

function rateLabel(rate: number): string {
  if (rate <= 0.5) return "excellent";
  if (rate <= 1.5) return "good";
  if (rate <= 4) return "moderate";
  return "high — consider clearer problem framing";
}

function generateNudges(report: PulseReport): string[] {
  const nudges: string[] = [];
  const { convergence: c, intentAnchoring: ia, decisionQuality: dq, tokenUsage: tu, interactionPattern: ip } = report;

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

  if (c.blindRetries >= 2) {
    nudges.push(`${c.blindRetries} blind retries detected — consecutive fix attempts without diagnosing the root cause. Ask "why is this happening?" before requesting another fix.`);
  }

  if (c.pivot) {
    const pivotLabel = c.pivot.type === "issue_creation" ? "creating an issue" : "requesting root cause analysis";
    nudges.push(`Session pivoted to ${pivotLabel} after ${c.pivot.fixAttemptsBefore} fix attempts. Starting with diagnosis next time can save ${c.pivot.fixAttemptsBefore - 1} iterations.`);
  }

  if (tu.available && tu.tokensPerExchange > 50000) {
    nudges.push("High tokens per exchange may indicate overly broad prompts or insufficient context upfront.");
  }

  if (report.promptEffectiveness.available) {
    const pe = report.promptEffectiveness;
    if (pe.scores.scopeDiscipline < 0.3 && c.exchanges > 3) {
      nudges.push("Many requests lack clear scope. Try stating what 'done' looks like before asking the agent to start.");
    }
    if (pe.scores.contextProvision < 0.2 && c.exchanges > 3) {
      nudges.push("Low context provision detected. Sharing relevant files, constraints, or error messages upfront can reduce iterations.");
    }
    if (pe.scores.feedbackQuality < 0.3 && pe.events.some(e => e.eventType === "CORRECTED_AGENT")) {
      nudges.push("Corrections tend to be vague. Include specific details (file, line, expected behavior) when redirecting the agent.");
    }
  }

  // Decision event nudges
  const de = report.decisionEvents;
  if (de.available && de.decisionCount === 0 && tu.available && tu.totalTokens > 10000) {
    nudges.push("No decision events detected despite significant token usage. Consider breaking work into smaller, committable increments.");
  }
  if (de.available && de.tokensPerDecision > 50000) {
    nudges.push(`${de.tokensPerDecision.toLocaleString()} tokens per decision is high. More frequent commits and smaller scope can improve decision yield.`);
  }

  return nudges;
}

export interface HistoricalScores {
  avgScores: Record<string, number>;
  firstOverall: number;
  overallTrend: number;
  count: number;
}

export function loadHistoricalScores(cwd: string, currentTimestamp: string): HistoricalScores | null {
  try {
    const all = loadReports(cwd);
    const prior = all.filter(
      (r) => r.promptEffectiveness.available && r.timestamp !== currentTimestamp
    );
    if (prior.length < 2) return null;

    const dims = ["contextProvision", "scopeDiscipline", "feedbackQuality", "decomposition", "verification"] as const;
    const avgScores: Record<string, number> = {};
    for (const dim of dims) {
      const sum = prior.reduce((s, r) => s + r.promptEffectiveness.scores[dim], 0);
      avgScores[dim] = Math.round((sum / prior.length) * 100) / 100;
    }

    // prior is newest-first from loadReports
    const firstOverall = prior[prior.length - 1].promptEffectiveness.overallScore;
    const lastOverall = prior[0].promptEffectiveness.overallScore;
    const overallTrend = lastOverall - firstOverall;

    return { avgScores, firstOverall, overallTrend, count: prior.length };
  } catch {
    return null;
  }
}

export async function runThreadPulse(worktreeId: string): Promise<ThreadPulseReport | string> {
  const { discoverThreads } = await import("./sessions.js");
  const groups = discoverThreads({ range: "30d" });
  const thread = groups.find((g) => g.worktreeId === worktreeId);
  if (!thread) {
    return `Thread ${worktreeId} not found. Run \`pulse sessions\` to see available threads.`;
  }

  if (thread.sessions.length === 0) {
    return `Thread ${worktreeId} has no sessions.`;
  }

  const agents: AgentReport[] = [];
  for (const session of thread.sessions) {
    const report = await runPulse(process.cwd(), session.filePath);
    agents.push({ role: session.role, sessionPath: session.filePath, report });
  }

  const aggregate = aggregateReports(agents.map((a) => a.report), thread.project);

  return {
    timestamp: new Date().toISOString(),
    worktreeId,
    project: thread.project,
    agents,
    aggregate,
  };
}

export function aggregateReports(reports: PulseReport[], project: string): PulseReport {
  // Convergence: sum exchanges, outcomes, rework; recalculate rate
  const totalExchanges = reports.reduce((s, r) => s + r.convergence.exchanges, 0);
  const totalOutcomes = reports.reduce((s, r) => s + r.convergence.outcomes, 0);
  const totalRework = reports.reduce((s, r) => s + r.convergence.reworkInstances, 0);
  const totalDuplicateCommits = reports.reduce((s, r) => s + r.convergence.duplicateCommits, 0);
  const rate = totalOutcomes > 0 ? Math.round((totalExchanges / totalOutcomes) * 100) / 100 : 0;
  const reworkPercent = totalExchanges > 0 ? Math.round((totalRework / totalExchanges) * 100) : 0;

  // Blind retries / pivot: take max across agents (the worst signal wins)
  const totalBlindRetries = reports.reduce((s, r) => s + r.convergence.blindRetries, 0);
  const pivot = reports.find(r => r.convergence.pivot !== null)?.convergence.pivot ?? null;

  const convergence = {
    exchanges: totalExchanges,
    outcomes: totalOutcomes,
    rate,
    reworkInstances: totalRework,
    reworkPercent,
    duplicateCommits: totalDuplicateCommits,
    blindRetries: totalBlindRetries,
    pivot,
  };

  // Tokens: sum all, recalculate ratios
  const totalInput = reports.reduce((s, r) => s + r.tokenUsage.inputTokens, 0);
  const totalOutput = reports.reduce((s, r) => s + r.tokenUsage.outputTokens, 0);
  const totalTokens = totalInput + totalOutput;
  const anyTokensAvailable = reports.some((r) => r.tokenUsage.available);
  const tokenUsage = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    totalTokens,
    tokensPerExchange: totalExchanges > 0 ? Math.round(totalTokens / totalExchanges) : 0,
    tokensPerOutcome: totalOutcomes > 0 ? Math.round(totalTokens / totalOutcomes) : 0,
    available: anyTokensAvailable,
  };

  // Decision events: merge all events, recalculate totals
  const allDecisionEvents = reports.flatMap(r => r.decisionEvents?.events ?? []);
  const anyDecisionEventsAvailable = reports.some(r => r.decisionEvents?.available);
  const totalDecisionCount = allDecisionEvents.length;
  const decisionEvents: DecisionEventsSignal = {
    events: allDecisionEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    decisionCount: totalDecisionCount,
    tokensPerDecision: totalDecisionCount > 0 ? Math.round(totalTokens / totalDecisionCount) : 0,
    available: anyDecisionEventsAvailable,
  };

  // Decision quality: union commit messages (dedup), recalculate totals
  const allMessages = [...new Set(reports.flatMap((r) => r.decisionQuality.commitMessages))];
  const whyPattern = /\b(because|so that|to prevent|to avoid|to ensure|in order to|this fixes|this resolves)\b/i;
  const issueRefPattern = /#\d+/;
  const commitsWithWhy = allMessages.filter((m) => whyPattern.test(m)).length;
  const commitsWithIssueRef = allMessages.filter((m) => issueRefPattern.test(m)).length;
  const externalContextProvided = reports.some((r) => r.decisionQuality.externalContextProvided);
  const decisionQuality = {
    commitsTotal: allMessages.length,
    commitsWithWhy,
    commitsWithIssueRef,
    externalContextProvided,
    commitMessages: allMessages,
  };

  // Prompt effectiveness: average scores across available sessions
  const peReports = reports.filter((r) => r.promptEffectiveness.available);
  let promptEffectiveness: PulseReport["promptEffectiveness"];
  if (peReports.length > 0) {
    const dims = ["contextProvision", "scopeDiscipline", "feedbackQuality", "decomposition", "verification"] as const;
    const scores: Record<string, number> = {};
    for (const dim of dims) {
      scores[dim] = Math.round((peReports.reduce((s, r) => s + r.promptEffectiveness.scores[dim], 0) / peReports.length) * 100) / 100;
    }
    const overallScore = Math.round((peReports.reduce((s, r) => s + r.promptEffectiveness.overallScore, 0) / peReports.length) * 100) / 100;
    promptEffectiveness = {
      available: true,
      events: peReports.flatMap((r) => r.promptEffectiveness.events),
      scores: scores as unknown as PulseReport["promptEffectiveness"]["scores"],
      overallScore,
      rating: overallScore >= 0.8 ? "excellent" : overallScore >= 0.6 ? "good" : overallScore >= 0.4 ? "moderate" : "developing",
      observation: `Aggregated from ${peReports.length} session(s)`,
      coaching: [...new Set(peReports.flatMap((r) => r.promptEffectiveness.coaching))],
    };
  } else {
    promptEffectiveness = {
      available: false,
      events: [],
      scores: { contextProvision: 0, scopeDiscipline: 0, feedbackQuality: 0, decomposition: 0, verification: 0 },
      overallScore: 0,
      rating: "developing",
      observation: "",
      coaching: [],
    };
  }

  // Interaction pattern: take from "main" role, or first session
  const mainReport = reports[0];
  const interactionPattern = mainReport?.interactionPattern ?? {
    userStyle: "directive" as const,
    contextProvision: "structured" as const,
    observation: "",
  };

  // Intent anchoring: take from first report (all sessions share the same project)
  const intentAnchoring = mainReport?.intentAnchoring ?? {
    intentsPresent: false,
    claudeMdPresent: false,
    declaredIntents: [],
    relevantIntents: [],
    referencedIntents: [],
    gap: [],
    intentLayerCheck: null,
  };

  // Leverage: compute from aggregate convergence + decision quality
  const { score: leverageScore, label: interactionLeverage } = computeLeverage(convergence, decisionQuality);

  return {
    timestamp: new Date().toISOString(),
    project,
    cwd: mainReport?.cwd ?? "",
    convergence,
    intentAnchoring,
    decisionQuality,
    tokenUsage,
    decisionEvents,
    interactionPattern,
    promptEffectiveness,
    interactionLeverage,
    leverageScore,
  };
}

export function formatThreadReport(threadReport: ThreadPulseReport): string {
  const lines: string[] = [];
  lines.push(`Pulse — Thread ${threadReport.worktreeId} (${threadReport.project})`);
  lines.push("═".repeat(60));
  lines.push(`${threadReport.timestamp} | ${threadReport.agents.length} agent(s)`);
  lines.push("");

  // Per-agent breakdown
  lines.push("AGENT BREAKDOWN");
  const header = "  " + "Role".padEnd(12) + "Exch".padStart(6) + "Out".padStart(6) + "Rate".padStart(7) + "Rework".padStart(8) + "Leverage".padStart(10);
  lines.push(header);
  lines.push("  " + "─".repeat(header.length - 2));

  for (const agent of threadReport.agents) {
    const r = agent.report;
    const role = agent.role.padEnd(12);
    const exch = String(r.convergence.exchanges).padStart(6);
    const out = String(r.convergence.outcomes).padStart(6);
    const rate = r.convergence.rate.toFixed(2).padStart(7);
    const rework = `${r.convergence.reworkPercent}%`.padStart(8);
    const leverage = `${r.leverageScore.toFixed(2)}`.padStart(10);
    lines.push(`  ${role}${exch}${out}${rate}${rework}${leverage}`);
  }
  lines.push("");

  // Aggregate report
  lines.push("AGGREGATE");
  lines.push(formatReport(threadReport.aggregate));

  return lines.join("\n");
}

export function formatDelta(current: number, avg: number): string {
  const diff = current - avg;
  if (Math.abs(diff) < 0.01) return "";
  const sign = diff > 0 ? "↑" : "↓";
  return `  ${sign} ${diff > 0 ? "+" : ""}${diff.toFixed(2)} vs avg`;
}
