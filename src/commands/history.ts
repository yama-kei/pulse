import { PulseReport } from "../types/pulse.js";
import { parseRange } from "../activity/range.js";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface HistoryEntry {
  timestamp: string;
  convergence_rate: number;
  prompt_effectiveness: number | null;
  leverage: string;
  outcomes: number;
  rework_percent: number;
}

export function runHistory(args: string[], projectDir: string): string {
  const flags = parseFlags(args);
  const json = (flags.json as boolean | undefined) ?? false;
  const range = flags.range as string | undefined;

  const reports = loadReports(projectDir);
  const filtered = range ? filterByRange(reports, range) : reports;
  const entries = filtered.map(toEntry);

  if (json) return JSON.stringify(entries, null, 2);
  return formatTable(entries);
}

function loadReports(projectDir: string): PulseReport[] {
  const pulseDir = join(projectDir, ".pulse");
  if (!existsSync(pulseDir)) return [];

  const files = readdirSync(pulseDir)
    .filter(f => f.startsWith("pulse-") && f.endsWith(".json"))
    .sort();

  const reports: PulseReport[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(pulseDir, file), "utf-8");
      const report = JSON.parse(content) as PulseReport;
      if (report.timestamp && report.convergence) {
        reports.push(report);
      }
    } catch {
      // skip malformed files
    }
  }
  return reports;
}

function filterByRange(reports: PulseReport[], range: string): PulseReport[] {
  const cutoff = parseRange(range);
  return reports.filter(r => new Date(r.timestamp) >= cutoff);
}

function toEntry(report: PulseReport): HistoryEntry {
  return {
    timestamp: report.timestamp,
    convergence_rate: report.convergence.rate,
    prompt_effectiveness: report.promptEffectiveness.available
      ? report.promptEffectiveness.overallScore
      : null,
    leverage: report.interactionLeverage,
    outcomes: report.convergence.outcomes,
    rework_percent: report.convergence.reworkPercent,
  };
}

function formatTable(entries: HistoryEntry[]): string {
  if (entries.length === 0) return "No reports found.";

  const lines: string[] = [];
  lines.push("DATE                 CONVERGENCE  EFFECTIVENESS  LEVERAGE  OUTCOMES  REWORK%");
  for (const e of entries) {
    const date = e.timestamp.slice(0, 19).replace("T", " ");
    const conv = e.convergence_rate.toFixed(2).padStart(11);
    const eff = e.prompt_effectiveness !== null
      ? e.prompt_effectiveness.toFixed(2).padStart(13)
      : "          n/a";
    const lev = e.leverage.padStart(8);
    const out = String(e.outcomes).padStart(8);
    const rw = (e.rework_percent + "%").padStart(7);
    lines.push(`${date}  ${conv}  ${eff}  ${lev}  ${out}  ${rw}`);
  }
  return lines.join("\n");
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg.startsWith("--") && i + 1 < args.length) {
      flags[arg.slice(2)] = args[++i];
    }
  }
  return flags;
}
