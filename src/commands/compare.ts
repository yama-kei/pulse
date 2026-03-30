import { PulseReport } from "../types/pulse.js";
import { loadReports } from "./history.js";
import { basename, resolve } from "node:path";

export interface CompareOptions {
  before?: string;
  json?: boolean;
}

export interface MetricComparison {
  metric: string;
  left: number | null;
  right: number | null;
  delta: number | null;
  direction: "improved" | "declined" | "stable" | "n/a";
  lowerIsBetter: boolean;
}

export interface CompareResult {
  mode: "date-split" | "cross-project";
  leftLabel: string;
  rightLabel: string;
  leftCount: number;
  rightCount: number;
  metrics: MetricComparison[];
}

function avgOrNull(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function computeMetrics(reports: PulseReport[]): Record<string, number | null> {
  return {
    convergenceRate: avgOrNull(reports.map((r) => r.convergence.rate)),
    reworkPercent: avgOrNull(reports.map((r) => r.convergence.reworkPercent)),
    leverageScore: avgOrNull(
      reports.map((r) =>
        r.leverageScore !== undefined
          ? r.leverageScore
          : r.interactionLeverage === "HIGH" ? 0.85 : r.interactionLeverage === "MEDIUM" ? 0.55 : 0.2
      )
    ),
    promptScore: avgOrNull(
      reports.map((r) => (r.promptEffectiveness.available ? r.promptEffectiveness.overallScore : null))
    ),
  };
}

function compareMetric(
  name: string,
  left: number | null,
  right: number | null,
  lowerIsBetter: boolean
): MetricComparison {
  if (left === null || right === null) {
    return { metric: name, left, right, delta: null, direction: "n/a", lowerIsBetter };
  }
  const delta = Math.round((right - left) * 100) / 100;
  const threshold = 0.01;
  let direction: MetricComparison["direction"];
  if (Math.abs(delta) < threshold) {
    direction = "stable";
  } else if (lowerIsBetter) {
    direction = delta < 0 ? "improved" : "declined";
  } else {
    direction = delta > 0 ? "improved" : "declined";
  }
  return { metric: name, left, right, delta, direction, lowerIsBetter };
}

function buildComparison(
  leftReports: PulseReport[],
  rightReports: PulseReport[],
  leftLabel: string,
  rightLabel: string,
  mode: CompareResult["mode"]
): CompareResult {
  const leftMetrics = computeMetrics(leftReports);
  const rightMetrics = computeMetrics(rightReports);

  const metrics: MetricComparison[] = [
    compareMetric("Convergence Rate", leftMetrics.convergenceRate, rightMetrics.convergenceRate, true),
    compareMetric("Rework %", leftMetrics.reworkPercent, rightMetrics.reworkPercent, true),
    compareMetric("Leverage Score", leftMetrics.leverageScore, rightMetrics.leverageScore, false),
    compareMetric("Prompt Score", leftMetrics.promptScore, rightMetrics.promptScore, false),
  ];

  return {
    mode,
    leftLabel,
    rightLabel,
    leftCount: leftReports.length,
    rightCount: rightReports.length,
    metrics,
  };
}

export function compareDateSplit(projectDir: string, beforeDate: string): CompareResult | string {
  const cutoff = new Date(beforeDate);
  if (isNaN(cutoff.getTime())) {
    return `Invalid date: ${beforeDate}. Use ISO format (e.g. 2026-03-15).`;
  }

  const all = loadReports(projectDir);
  if (all.length === 0) {
    return "No pulse reports found. Run `pulse` to generate reports.";
  }

  const before = all.filter((r) => new Date(r.timestamp) < cutoff);
  const after = all.filter((r) => new Date(r.timestamp) >= cutoff);

  if (before.length < 2) {
    return `Need at least 2 reports before ${beforeDate} (found ${before.length}). Generate more reports first.`;
  }
  if (after.length < 2) {
    return `Need at least 2 reports after ${beforeDate} (found ${after.length}). Generate more reports first.`;
  }

  return buildComparison(before, after, `before ${beforeDate}`, `after ${beforeDate}`, "date-split");
}

export function compareCrossProject(pathA: string, pathB: string): CompareResult | string {
  const reportsA = loadReports(pathA);
  const reportsB = loadReports(pathB);

  if (reportsA.length < 2) {
    return `Need at least 2 reports in ${pathA} (found ${reportsA.length}). Generate more reports first.`;
  }
  if (reportsB.length < 2) {
    return `Need at least 2 reports in ${pathB} (found ${reportsB.length}). Generate more reports first.`;
  }

  const labelA = basename(pathA) || pathA;
  const labelB = basename(pathB) || pathB;

  return buildComparison(reportsA, reportsB, labelA, labelB, "cross-project");
}

function formatMetricValue(metric: string, value: number | null): string {
  if (value === null) return "n/a";
  if (metric === "Rework %") return `${value}%`;
  return value.toFixed(2);
}

function formatDelta(metric: string, delta: number | null, direction: string): string {
  if (delta === null) return "n/a";
  const sign = delta > 0 ? "+" : "";
  const suffix = metric === "Rework %" ? "%" : "";
  return `${sign}${delta.toFixed(2)}${suffix} (${direction})`;
}

export function formatComparison(result: CompareResult): string {
  const lines: string[] = [];
  const header = result.mode === "date-split"
    ? `Pulse Comparison (${result.leftLabel} vs ${result.rightLabel})`
    : `Pulse Comparison (${result.leftLabel} vs ${result.rightLabel})`;

  lines.push(header);
  lines.push("─".repeat(60));
  lines.push(`Reports: ${result.leftCount} vs ${result.rightCount}`);
  lines.push("");

  const col1 = 22;
  const col2 = 10;
  const col3 = 10;

  const leftHeader = result.mode === "date-split" ? "Before" : result.leftLabel;
  const rightHeader = result.mode === "date-split" ? "After" : result.rightLabel;

  lines.push(
    "".padEnd(col1) +
    leftHeader.padStart(col2) +
    rightHeader.padStart(col2) +
    "Delta".padStart(col2 + 14)
  );

  for (const m of result.metrics) {
    const left = formatMetricValue(m.metric, m.left).padStart(col2);
    const right = formatMetricValue(m.metric, m.right).padStart(col3);
    const delta = formatDelta(m.metric, m.delta, m.direction);
    lines.push(`${m.metric.padEnd(col1)}${left}${right}     ${delta}`);
  }

  return lines.join("\n");
}

export function runCompare(argv: string[]): string {
  const jsonFlag = argv.includes("--json");
  const beforeIdx = argv.indexOf("--before");
  const beforeDate = beforeIdx !== -1 && beforeIdx + 1 < argv.length ? argv[beforeIdx + 1] : undefined;

  // Collect positional args (not flags or flag values)
  const skipNext = new Set<number>();
  if (beforeIdx !== -1) { skipNext.add(beforeIdx); skipNext.add(beforeIdx + 1); }
  const jsonIdx = argv.indexOf("--json");
  if (jsonIdx !== -1) skipNext.add(jsonIdx);

  const positional = argv.filter((a, i) => !skipNext.has(i) && !a.startsWith("--"));

  if (beforeDate) {
    // Date-split mode
    const projectDir = resolve(positional[0] || process.cwd());
    const result = compareDateSplit(projectDir, beforeDate);
    if (typeof result === "string") return result;
    return jsonFlag ? JSON.stringify(result, null, 2) : formatComparison(result);
  }

  if (positional.length >= 2) {
    // Cross-project mode
    const pathA = resolve(positional[0]);
    const pathB = resolve(positional[1]);
    const result = compareCrossProject(pathA, pathB);
    if (typeof result === "string") return result;
    return jsonFlag ? JSON.stringify(result, null, 2) : formatComparison(result);
  }

  return "Usage: pulse compare --before <date> [path]  or  pulse compare /path/a /path/b\n\nOptions:\n  --before <date>  Split reports at date (ISO format)\n  --json           Output as JSON";
}
