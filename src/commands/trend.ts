import { PulseReport } from "../types/pulse.js";
import { loadReports } from "./history.js";
import { parseRange } from "../activity/range.js";

const SPARKS = "▁▂▃▄▅▆▇█";

export interface TrendOptions {
  range?: string;
  json?: boolean;
  metric?: string;
}

export interface TrendData {
  metric: string;
  values: Array<{ date: string; value: number | null }>;
  min: number | null;
  max: number | null;
  current: number | null;
  direction: "improving" | "declining" | "stable" | "unknown";
  hint: string;
}

export function sparkline(values: (number | null)[], invert: boolean = false): string {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min;

  return values
    .map((v) => {
      if (v === null) return " ";
      const normalized = range === 0 ? 0.5 : (v - min) / range;
      const idx = invert
        ? Math.round((1 - normalized) * (SPARKS.length - 1))
        : Math.round(normalized * (SPARKS.length - 1));
      return SPARKS[idx];
    })
    .join("");
}

function direction(
  values: (number | null)[],
  lowerIsBetter: boolean
): "improving" | "declining" | "stable" | "unknown" {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return "unknown";
  const first = nums[0];
  const last = nums[nums.length - 1];
  const diff = last - first;
  const threshold = Math.abs(first) * 0.1 || 0.1;
  if (Math.abs(diff) < threshold) return "stable";
  if (lowerIsBetter) return diff < 0 ? "improving" : "declining";
  return diff > 0 ? "improving" : "declining";
}

export function extractTrends(reports: PulseReport[]): TrendData[] {
  // Reports come in newest-first; reverse for chronological (oldest first)
  const chrono = [...reports].reverse();

  const convergenceValues = chrono.map((r) => ({
    date: r.timestamp.slice(0, 10),
    value: r.convergence.rate,
  }));
  const convergenceNums = convergenceValues.map((v) => v.value);

  const promptValues = chrono.map((r) => ({
    date: r.timestamp.slice(0, 10),
    value: r.promptEffectiveness.available ? r.promptEffectiveness.overallScore : null,
  }));
  const promptNums = promptValues.map((v) => v.value);

  const reworkValues = chrono.map((r) => ({
    date: r.timestamp.slice(0, 10),
    value: r.convergence.reworkPercent,
  }));
  const reworkNums = reworkValues.map((v) => v.value);

  const leverageValues = chrono.map((r) => ({
    date: r.timestamp.slice(0, 10),
    value: r.interactionLeverage === "HIGH" ? 3 : r.interactionLeverage === "MEDIUM" ? 2 : 1,
  }));
  const leverageNums = leverageValues.map((v) => v.value);

  return [
    {
      metric: "convergence",
      values: convergenceValues,
      min: convergenceNums.length ? Math.min(...convergenceNums) : null,
      max: convergenceNums.length ? Math.max(...convergenceNums) : null,
      current: convergenceNums.length ? convergenceNums[convergenceNums.length - 1] : null,
      direction: direction(convergenceNums, true),
      hint: "lower is better",
    },
    {
      metric: "prompt",
      values: promptValues,
      min: minNullable(promptNums),
      max: maxNullable(promptNums),
      current: lastNullable(promptNums),
      direction: direction(promptNums, false),
      hint: "higher is better",
    },
    {
      metric: "rework",
      values: reworkValues,
      min: reworkNums.length ? Math.min(...reworkNums) : null,
      max: reworkNums.length ? Math.max(...reworkNums) : null,
      current: reworkNums.length ? reworkNums[reworkNums.length - 1] : null,
      direction: direction(reworkNums, true),
      hint: "lower is better",
    },
    {
      metric: "leverage",
      values: leverageValues,
      min: leverageNums.length ? Math.min(...leverageNums) : null,
      max: leverageNums.length ? Math.max(...leverageNums) : null,
      current: leverageNums.length ? leverageNums[leverageNums.length - 1] : null,
      direction: direction(leverageNums, false),
      hint: "higher is better",
    },
  ];
}

function minNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.min(...nums) : null;
}

function maxNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

function lastNullable(values: (number | null)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return values[i];
  }
  return null;
}

function formatValue(metric: string, value: number | null): string {
  if (value === null) return "n/a";
  if (metric === "rework") return `${value}%`;
  if (metric === "leverage") return value === 3 ? "HIGH" : value === 2 ? "MEDIUM" : "LOW";
  return value.toFixed(2);
}

export function formatTrend(trends: TrendData[], reportCount: number, rangeLabel: string): string {
  const lines: string[] = [];
  lines.push(`Pulse Trends (${rangeLabel}, ${reportCount} reports)`);
  lines.push("─".repeat(50));
  lines.push("");

  const labels: Record<string, string> = {
    convergence: "Convergence Rate",
    prompt: "Prompt Score",
    rework: "Rework %",
    leverage: "Leverage",
  };

  for (const t of trends) {
    const label = (labels[t.metric] ?? t.metric).padEnd(20);
    const spark = t.metric === "leverage"
      ? t.values.map((v) => v.value === 3 ? "HIGH" : v.value === 2 ? "MED" : "LOW").join(" ")
      : sparkline(t.values.map((v) => v.value), t.hint === "lower is better");
    const first = t.values.length > 0 ? formatValue(t.metric, t.values[0].value) : "n/a";
    const last = formatValue(t.metric, t.current);
    lines.push(`${label}${spark}   ${first} → ${last}  (${t.hint})`);
  }

  return lines.join("\n");
}

export function runTrend(projectDir: string, opts: TrendOptions): string {
  let reports = loadReports(projectDir);

  if (reports.length < 2) {
    return "Need at least 2 pulse reports to show trends. Run `pulse` to generate reports.";
  }

  let rangeLabel = "all time";
  if (opts.range) {
    const cutoff = parseRange(opts.range);
    reports = reports.filter((r) => new Date(r.timestamp) >= cutoff);
    rangeLabel = `last ${opts.range}`;
    if (reports.length < 2) {
      return `Need at least 2 pulse reports in the last ${opts.range} to show trends.`;
    }
  }

  let trends = extractTrends(reports);

  if (opts.metric) {
    trends = trends.filter((t) => t.metric === opts.metric);
    if (trends.length === 0) {
      return `Unknown metric: ${opts.metric}. Available: convergence, prompt, rework, leverage`;
    }
  }

  if (opts.json) {
    return JSON.stringify(trends, null, 2);
  }

  return formatTrend(trends, reports.length, rangeLabel);
}
