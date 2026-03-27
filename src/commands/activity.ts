import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readEvents, ReadEventsOptions } from "../activity/reader.js";
import { aggregateSessions, aggregateSummary } from "../activity/aggregator.js";
import { BucketSize, SessionEventType } from "../types/pulse.js";

export function parseRange(range: string): Date {
  const match = range.match(/^(\d+)([hdw])$/);
  if (!match) {
    console.error(`Invalid range: ${range}. Use format like 24h, 7d, 30d.`);
    process.exit(1);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = new Date();
  switch (unit) {
    case "h": now.setHours(now.getHours() - value); break;
    case "d": now.setDate(now.getDate() - value); break;
    case "w": now.setDate(now.getDate() - value * 7); break;
  }
  return now;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function runActivitySessions(args: string[]): void {
  const source = parseFlag(args, "--source") || "mpg-sessions";
  const range = parseFlag(args, "--range") || "7d";
  const project = parseFlag(args, "--project");
  const eventType = parseFlag(args, "--type") as SessionEventType | undefined;
  const jsonFlag = args.includes("--json");

  const since = parseRange(range);
  const options: ReadEventsOptions = { since, projectKey: project, eventType };
  const events = readEvents(source, options);

  const filters: Record<string, string | undefined> = { source, range, project, type: eventType };

  if (jsonFlag) {
    const output = aggregateSessions(source, events, filters);
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Human-readable table
  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  console.log(`Events from ${source} (last ${range}):\n`);
  console.log("Timestamp                    Type              Session     Project");
  console.log("─".repeat(80));
  for (const e of events) {
    const ts = e.timestamp.replace("T", " ").replace("Z", "");
    const type = e.event_type.padEnd(18);
    const sid = e.session_id.slice(0, 10).padEnd(12);
    console.log(`${ts}  ${type}${sid}${e.project_key}`);
  }
  console.log(`\n${events.length} event(s)`);
}

export function runActivitySummary(args: string[]): void {
  const source = parseFlag(args, "--source") || "mpg-sessions";
  const range = parseFlag(args, "--range") || "7d";
  const project = parseFlag(args, "--project");
  const bucket = (parseFlag(args, "--bucket") || "day") as BucketSize;
  const jsonFlag = args.includes("--json");

  const since = parseRange(range);
  const options: ReadEventsOptions = { since, projectKey: project };
  const events = readEvents(source, options);

  const filters: Record<string, string | undefined> = { source, range, project, bucket };
  const summary = aggregateSummary(source, events, bucket, filters);

  if (jsonFlag) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Human-readable summary
  if (events.length === 0) {
    console.log("No events found.");
    return;
  }

  console.log(`Activity Summary — ${source} (last ${range}, bucket: ${bucket})\n`);

  if (summary.sessions_per_bucket.length > 0) {
    console.log("Sessions per bucket:");
    for (const s of summary.sessions_per_bucket) {
      console.log(`  ${s.bucket}  ${s.project_key}: ${s.count}`);
    }
    console.log("");
  }

  if (summary.duration_stats.length > 0) {
    console.log("Duration stats:");
    for (const d of summary.duration_stats) {
      const avg = (d.avg_ms / 60000).toFixed(1);
      const med = (d.median_ms / 60000).toFixed(1);
      const p95 = (d.p95_ms / 60000).toFixed(1);
      console.log(`  ${d.project_key}: avg=${avg}m  median=${med}m  p95=${p95}m`);
    }
    console.log("");
  }

  if (summary.peak_concurrent.length > 0) {
    console.log("Peak concurrent sessions:");
    for (const p of summary.peak_concurrent) {
      console.log(`  ${p.bucket}: ${p.max_concurrent}`);
    }
  }
}

export interface GcResult {
  removed: number;
  kept: number;
}

export function gcEvents(filePath: string, cutoff: Date, dryRun: boolean): GcResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { removed: 0, kept: 0 };
  }

  const lines = content.split("\n");
  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);
      const ts = new Date(parsed.timestamp);
      if (ts < cutoff) {
        removed++;
        continue;
      }
    } catch {
      // Keep malformed lines (don't silently delete data)
      kept.push(trimmed);
      continue;
    }
    kept.push(trimmed);
  }

  if (!dryRun) {
    writeFileSync(filePath, kept.length > 0 ? kept.join("\n") + "\n" : "");
  }

  return { removed, kept: kept.length };
}

export function runActivityGc(args: string[]): void {
  const source = parseFlag(args, "--source") || "mpg-sessions";
  const retention = parseFlag(args, "--retention") || "30d";
  const dryRun = args.includes("--dry-run");

  const dir = join(homedir(), ".pulse", "events");
  const filePath = join(dir, `${source}.jsonl`);

  const cutoff = parseRange(retention);
  const result = gcEvents(filePath, cutoff, dryRun);

  if (result.removed === 0 && result.kept === 0) {
    console.log("No events file found. Nothing to do.");
    return;
  }

  if (dryRun) {
    console.log(`Would remove ${result.removed} event(s) older than ${retention}.`);
    console.log(`Would keep ${result.kept} event(s).`);
    return;
  }

  console.log(`Removed ${result.removed} event(s) older than ${retention}. ${result.kept} remaining.`);
}
