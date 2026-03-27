import { MpgSessionEvent, ActivitySession, ActivitySummary, BucketedSessions } from "../types/pulse.js";

export function aggregateSessions(events: MpgSessionEvent[]): ActivitySession[] {
  const sessionMap = new Map<string, {
    project_key: string;
    project_dir: string;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    message_count: number;
    idle_count: number;
    resume_count: number;
  }>();

  for (const e of events) {
    if (!sessionMap.has(e.session_id)) {
      sessionMap.set(e.session_id, {
        project_key: e.project_key,
        project_dir: e.project_dir,
        started_at: e.timestamp,
        ended_at: null,
        duration_ms: null,
        message_count: 0,
        idle_count: 0,
        resume_count: 0,
      });
    }
    const s = sessionMap.get(e.session_id)!;
    switch (e.event_type) {
      case "session_start":
        s.started_at = e.timestamp;
        break;
      case "session_end":
        s.ended_at = e.timestamp;
        s.duration_ms = e.duration_ms ?? null;
        break;
      case "message_routed":
        s.message_count++;
        break;
      case "session_idle":
        s.idle_count++;
        break;
      case "session_resume":
        s.resume_count++;
        break;
    }
  }

  return Array.from(sessionMap.entries()).map(([session_id, s]) => ({
    session_id,
    ...s,
  }));
}

export function aggregateSummary(
  events: MpgSessionEvent[],
  source: string,
  rangeStart: Date,
  rangeEnd: Date
): ActivitySummary {
  const sessions = aggregateSessions(events);
  const durations = sessions
    .map(s => s.duration_ms)
    .filter((d): d is number => d !== null);

  const totalMessages = sessions.reduce((sum, s) => sum + s.message_count, 0);

  const projects: Record<string, { sessions: number; messages: number }> = {};
  for (const s of sessions) {
    if (!projects[s.project_key]) {
      projects[s.project_key] = { sessions: 0, messages: 0 };
    }
    projects[s.project_key].sessions++;
    projects[s.project_key].messages += s.message_count;
  }

  return {
    source,
    range_start: rangeStart.toISOString(),
    range_end: rangeEnd.toISOString(),
    total_sessions: sessions.length,
    total_messages: totalMessages,
    avg_duration_ms: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    median_duration_ms: median(durations),
    projects,
    peak_concurrent: computePeakConcurrent(events),
  };
}

export function bucketSessions(
  events: MpgSessionEvent[],
  bucketSize: "hour" | "day"
): BucketedSessions {
  const starts = events.filter(e => e.event_type === "session_start");
  const bucketMap = new Map<string, number>();

  for (const e of starts) {
    const key = bucketSize === "hour"
      ? e.timestamp.slice(0, 13)
      : e.timestamp.slice(0, 10);
    bucketMap.set(key, (bucketMap.get(key) ?? 0) + 1);
  }

  const buckets = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, session_count]) => ({ bucket, session_count }));

  return { bucket_size: bucketSize, buckets };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function computePeakConcurrent(events: MpgSessionEvent[]): number {
  const deltas: Array<{ time: number; delta: number }> = [];
  for (const e of events) {
    const time = new Date(e.timestamp).getTime();
    if (e.event_type === "session_start" || e.event_type === "session_resume") {
      deltas.push({ time, delta: 1 });
    } else if (e.event_type === "session_end" || e.event_type === "session_idle") {
      deltas.push({ time, delta: -1 });
    }
  }
  deltas.sort((a, b) => a.time - b.time || b.delta - a.delta);

  let current = 0;
  let peak = 0;
  for (const { delta } of deltas) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}
