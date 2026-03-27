import { readEvents, eventsFilePath } from "../activity/reader.js";
import { aggregateSessions, aggregateSummary, bucketSessions } from "../activity/aggregator.js";
import { parseRange } from "../activity/range.js";
import { GcResult } from "../types/pulse.js";
import { writeFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function runActivity(args: string[], baseDir?: string): string {
  const sub = args[0];
  const flags = parseFlags(args.slice(1));
  const source = (flags.source as string | undefined) ?? "mpg";
  const range = (flags.range as string | undefined) ?? "7d";
  const project = flags.project as string | undefined;
  const json = (flags.json as boolean | undefined) ?? false;
  const dir = baseDir ?? join(homedir(), ".pulse");

  switch (sub) {
    case "sessions":
      return handleSessions(dir, source, range, project, flags.bucket as string | undefined, json);
    case "summary":
      return handleSummary(dir, source, range, project, json);
    case "gc":
      return handleGc(dir, source, (flags.retain as string | undefined) ?? "30d", (flags["dry-run"] as boolean | undefined) ?? false);
    default:
      return activityHelp();
  }
}

function handleSessions(
  dir: string, source: string, range: string, project: string | undefined,
  bucket: string | undefined, json: boolean
): string {
  const now = new Date();
  const after = parseRange(range, now);
  const events = readEvents(dir, source, { after, project });

  if (bucket) {
    if (bucket !== "hour" && bucket !== "day") {
      return `Error: --bucket must be "hour" or "day", got "${bucket}"`;
    }
    const result = bucketSessions(events, bucket);
    if (json) return JSON.stringify(result, null, 2);
    return formatBucketed(result);
  }

  const sessions = aggregateSessions(events);
  if (json) return JSON.stringify(sessions, null, 2);
  return formatSessions(sessions);
}

function handleSummary(
  dir: string, source: string, range: string, project: string | undefined, json: boolean
): string {
  const now = new Date();
  const after = parseRange(range, now);
  const events = readEvents(dir, source, { after, project });
  const summary = aggregateSummary(events, source, after, now);
  if (json) return JSON.stringify(summary, null, 2);
  return formatSummary(summary);
}

function handleGc(dir: string, source: string, retain: string, dryRun: boolean): string {
  const now = new Date();
  const cutoff = parseRange(retain, now);
  const allEvents = readEvents(dir, source);
  const kept = allEvents.filter(e => new Date(e.timestamp) >= cutoff);
  const removed = allEvents.length - kept.length;

  if (!dryRun) {
    const filePath = eventsFilePath(dir, source);
    if (existsSync(filePath)) {
      const lines = kept.map(e => JSON.stringify(e));
      const tmpPath = filePath + ".tmp";
      writeFileSync(tmpPath, lines.length > 0 ? lines.join("\n") + "\n" : "");
      renameSync(tmpPath, filePath);
    }
  }

  const result: GcResult = { source, removed, retained: kept.length, dry_run: dryRun };
  return JSON.stringify(result, null, 2);
}

function formatSessions(sessions: Array<{ session_id: string; project_key: string; started_at: string; duration_ms: number | null; message_count: number }>): string {
  if (sessions.length === 0) return "No sessions found.";
  const lines = ["SESSION ID       PROJECT          STARTED                    DURATION    MESSAGES"];
  for (const s of sessions) {
    const dur = s.duration_ms ? `${Math.round(s.duration_ms / 60_000)}m` : "active";
    lines.push(`${s.session_id.padEnd(16)} ${s.project_key.padEnd(16)} ${s.started_at.padEnd(26)} ${dur.padEnd(11)} ${s.message_count}`);
  }
  return lines.join("\n");
}

function formatBucketed(result: { bucket_size: string; buckets: Array<{ bucket: string; session_count: number }> }): string {
  if (result.buckets.length === 0) return "No sessions found.";
  const lines = [`Sessions by ${result.bucket_size}:`, ""];
  for (const b of result.buckets) {
    const bar = "█".repeat(b.session_count);
    lines.push(`  ${b.bucket}  ${bar} ${b.session_count}`);
  }
  return lines.join("\n");
}

function formatSummary(summary: { total_sessions: number; total_messages: number; avg_duration_ms: number | null; median_duration_ms: number | null; peak_concurrent: number; projects: Record<string, { sessions: number; messages: number }> }): string {
  const lines = [
    "ACTIVITY SUMMARY",
    "═".repeat(40),
    `  Sessions:           ${summary.total_sessions}`,
    `  Messages:           ${summary.total_messages}`,
    `  Avg duration:       ${summary.avg_duration_ms ? `${Math.round(summary.avg_duration_ms / 60_000)}m` : "n/a"}`,
    `  Median duration:    ${summary.median_duration_ms ? `${Math.round(summary.median_duration_ms / 60_000)}m` : "n/a"}`,
    `  Peak concurrent:    ${summary.peak_concurrent}`,
    "",
    "  Projects:",
  ];
  for (const [key, val] of Object.entries(summary.projects)) {
    lines.push(`    ${key}: ${val.sessions} sessions, ${val.messages} messages`);
  }
  return lines.join("\n");
}

function activityHelp(): string {
  return `
pulse activity — session activity tracking

Usage:
  pulse activity sessions [flags]   List sessions
  pulse activity summary  [flags]   Aggregated summary
  pulse activity gc       [flags]   Remove old events

Flags:
  --source <name>     Event source (default: mpg)
  --range <duration>  Time range: 7d, 24h, 30m (default: 7d)
  --project <key>     Filter by project key
  --bucket <size>     Bucket by: hour, day (sessions only)
  --json              Output raw JSON
  --retain <duration> Retention period for gc (default: 30d)
  --dry-run           Show what gc would remove
`.trim();
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--dry-run") {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--") && i + 1 < args.length) {
      flags[arg.slice(2)] = args[++i];
    }
  }
  return flags;
}
