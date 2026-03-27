import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionEvent, SessionEventType } from "../types/pulse.js";

export interface ReadEventsOptions {
  eventsDir?: string;
  since?: Date;
  until?: Date;
  projectKey?: string;
  eventType?: SessionEventType;
}

const SUPPORTED_SCHEMA_VERSION = 1;

function defaultEventsDir(): string {
  return join(homedir(), ".pulse", "events");
}

export function readEvents(source: string, options?: ReadEventsOptions): SessionEvent[] {
  const dir = options?.eventsDir ?? defaultEventsDir();
  const filePath = join(dir, `${source}.jsonl`);

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const events: SessionEvent[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`pulse: skipping malformed JSONL line\n`);
      continue;
    }

    if (parsed.schema_version !== SUPPORTED_SCHEMA_VERSION) {
      process.stderr.write(`pulse: skipping event with schema_version ${parsed.schema_version}\n`);
      continue;
    }

    if (!parsed.timestamp || !parsed.event_type || !parsed.session_id) {
      process.stderr.write(`pulse: skipping event missing required fields\n`);
      continue;
    }

    const ts = new Date(parsed.timestamp);
    if (options?.since && ts < options.since) continue;
    if (options?.until && ts >= options.until) continue;
    if (options?.projectKey && parsed.project_key !== options.projectKey) continue;
    if (options?.eventType && parsed.event_type !== options.eventType) continue;

    events.push(parsed as SessionEvent);
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}
