import {
  SessionEvent,
  SessionStartEvent,
  SessionEndEvent,
  ActivitySessions,
  ActivitySummary,
  BucketSize,
} from "../types/pulse.js";

export function aggregateSessions(
  source: string,
  events: SessionEvent[],
  filters: Record<string, string | undefined>
): ActivitySessions {
  return { source, filters, events };
}

export function aggregateSummary(
  source: string,
  events: SessionEvent[],
  bucket: BucketSize,
  filters: Record<string, string | undefined>
): ActivitySummary {
  return {
    source,
    filters,
    bucket,
    sessions_per_bucket: computeSessionsPerBucket(events, bucket),
    duration_stats: computeDurationStats(events),
    message_volume: computeMessageVolume(events, bucket),
    persona_breakdown: computePersonaBreakdown(events),
    peak_concurrent: computePeakConcurrent(events, bucket),
  };
}

function truncateToBucket(timestamp: string, bucket: BucketSize): string {
  const d = new Date(timestamp);
  if (bucket === "hour") {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
  }
  if (bucket === "day") {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  // week: Monday-based ISO week start
  const day = d.getUTCDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - mondayOffset);
  return `${monday.getUTCFullYear()}-W${pad(getISOWeek(monday))}`;
}

function getISOWeek(d: Date): number {
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dayOfYear = Math.floor((d.getTime() - jan4.getTime()) / 86400000) + 4;
  return Math.ceil(dayOfYear / 7);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function computeSessionsPerBucket(events: SessionEvent[], bucket: BucketSize): ActivitySummary["sessions_per_bucket"] {
  const starts = events.filter((e): e is SessionStartEvent => e.event_type === "session_start");
  const map = new Map<string, number>();

  for (const e of starts) {
    const key = `${truncateToBucket(e.timestamp, bucket)}\0${e.project_key}`;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return Array.from(map.entries()).map(([key, count]) => {
    const sep = key.indexOf("\0");
    return { bucket: key.slice(0, sep), project_key: key.slice(sep + 1), count };
  });
}

function computeDurationStats(events: SessionEvent[]): ActivitySummary["duration_stats"] {
  const ends = events.filter((e): e is SessionEndEvent => e.event_type === "session_end");
  const byProject = new Map<string, number[]>();

  for (const e of ends) {
    const durations = byProject.get(e.project_key) || [];
    durations.push(e.duration_ms);
    byProject.set(e.project_key, durations);
  }

  return Array.from(byProject.entries()).map(([project_key, durations]) => {
    durations.sort((a, b) => a - b);
    const avg_ms = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    const median_ms = percentile(durations, 50);
    const p95_ms = percentile(durations, 95);
    return { project_key, avg_ms, median_ms, p95_ms };
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower));
}

function computeMessageVolume(events: SessionEvent[], bucket: BucketSize): ActivitySummary["message_volume"] {
  const routed = events.filter(e => e.event_type === "message_routed");
  const map = new Map<string, number>();

  for (const e of routed) {
    const key = `${truncateToBucket(e.timestamp, bucket)}\0${e.project_key}`;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return Array.from(map.entries()).map(([key, count]) => {
    const sep = key.indexOf("\0");
    return { bucket: key.slice(0, sep), project_key: key.slice(sep + 1), count };
  });
}

function computePersonaBreakdown(events: SessionEvent[]): ActivitySummary["persona_breakdown"] {
  const starts = events.filter((e): e is SessionStartEvent => e.event_type === "session_start");
  const map = new Map<string, number>();

  for (const e of starts) {
    const agent = e.agent_name || "(none)";
    const key = `${e.project_key}\0${agent}`;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return Array.from(map.entries()).map(([key, count]) => {
    const sep = key.indexOf("\0");
    return { project_key: key.slice(0, sep), agent: key.slice(sep + 1), count };
  });
}

function computePeakConcurrent(events: SessionEvent[], bucket: BucketSize): ActivitySummary["peak_concurrent"] {
  const starts = events.filter(e => e.event_type === "session_start");
  const ends = events.filter((e): e is SessionEndEvent => e.event_type === "session_end");

  const endBySession = new Map<string, string>();
  for (const e of ends) {
    endBySession.set(e.session_id, e.timestamp);
  }

  type TimePoint = { time: number; delta: number };
  const bucketPoints = new Map<string, TimePoint[]>();

  for (const s of starts) {
    const b = truncateToBucket(s.timestamp, bucket);
    const points = bucketPoints.get(b) || [];
    const startTime = new Date(s.timestamp).getTime();
    points.push({ time: startTime, delta: 1 });

    const endTs = endBySession.get(s.session_id);
    if (endTs) {
      points.push({ time: new Date(endTs).getTime(), delta: -1 });
    }

    bucketPoints.set(b, points);
  }

  return Array.from(bucketPoints.entries()).map(([b, points]) => {
    points.sort((a, b) => a.time - b.time || a.delta - b.delta);
    let current = 0;
    let max = 0;
    for (const p of points) {
      current += p.delta;
      if (current > max) max = current;
    }
    return { bucket: b, max_concurrent: max };
  });
}
