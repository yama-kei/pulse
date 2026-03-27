import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MpgSessionEvent } from "../types/pulse.js";

export interface ReadOptions {
  after?: Date;
  project?: string;
}

export function readEvents(
  baseDir: string,
  source: string,
  options: ReadOptions = {}
): MpgSessionEvent[] {
  const filePath = join(baseDir, "events", `${source}-sessions.jsonl`);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const events: MpgSessionEvent[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed.session_id || !parsed.event_type || !parsed.timestamp) continue;
      if (options.after && new Date(parsed.timestamp) < options.after) continue;
      if (options.project && parsed.project_key !== options.project) continue;
      events.push(parsed as MpgSessionEvent);
    } catch {
      // skip malformed lines
    }
  }

  return events;
}

export function eventsFilePath(baseDir: string, source: string): string {
  return join(baseDir, "events", `${source}-sessions.jsonl`);
}
