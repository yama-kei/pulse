import { PulseReport } from "../types/pulse.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRange } from "../activity/range.js";

export function loadReports(projectDir: string): PulseReport[] {
  const pulseDir = join(projectDir, ".pulse");
  if (!existsSync(pulseDir)) return [];

  const files = readdirSync(pulseDir).filter((f) => f.startsWith("pulse-") && f.endsWith(".json"));
  const reports: PulseReport[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(pulseDir, file), "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.timestamp === "string" && parsed.convergence) {
        reports.push(parsed as PulseReport);
      }
    } catch {
      // Skip malformed files
    }
  }

  reports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return reports;
}

export interface HistoryOptions {
  range?: string;
  json?: boolean;
}

interface ReportSummary {
  date: string;
  convergenceRate: number;
  promptScore: number | null;
  leverage: string;
  outcomes: number;
}

function summarize(report: PulseReport): ReportSummary {
  return {
    date: report.timestamp.slice(0, 10),
    convergenceRate: report.convergence.rate,
    promptScore: report.promptEffectiveness.available ? report.promptEffectiveness.overallScore : null,
    leverage: report.leverageScore !== undefined
      ? `${report.leverageScore.toFixed(2)} (${report.interactionLeverage})`
      : report.interactionLeverage,
    outcomes: report.convergence.outcomes,
  };
}

export function formatHistoryTable(reports: PulseReport[]): string {
  const summaries = reports.map(summarize);
  const header = "DATE        CONV.RATE  PROMPT  LEVERAGE  OUTCOMES";
  const sep = "─".repeat(header.length);
  const rows = summaries.map((s) => {
    const prompt = s.promptScore !== null ? s.promptScore.toFixed(2).padStart(6) : "   n/a";
    return `${s.date}  ${String(s.convergenceRate.toFixed(2)).padStart(9)}  ${prompt}  ${s.leverage.padEnd(8)}  ${String(s.outcomes).padStart(8)}`;
  });
  return [header, sep, ...rows].join("\n");
}

export function runHistory(projectDir: string, opts: HistoryOptions): string {
  let reports = loadReports(projectDir);

  if (reports.length === 0) {
    return "No pulse reports found. Run `pulse` to generate your first report.";
  }

  if (opts.range) {
    const cutoff = parseRange(opts.range);
    reports = reports.filter((r) => new Date(r.timestamp) >= cutoff);
    if (reports.length === 0) {
      return `No pulse reports found in the last ${opts.range}.`;
    }
  }

  if (opts.json) {
    return JSON.stringify(reports.map(summarize), null, 2);
  }

  return formatHistoryTable(reports);
}
