import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { basename } from "node:path";
import { MpgSessionEvent, CorrelatedMpgData } from "../types/pulse.js";

/**
 * Default path for MPG runtime events.
 */
function mpgEventsPath(): string {
  return join(homedir(), ".pulse", "events", "mpg-sessions.jsonl");
}

/**
 * Read all MPG session events from the default events file.
 * Returns empty array if file doesn't exist or is unreadable.
 */
export function readMpgEvents(eventsPath?: string): MpgSessionEvent[] {
  const filePath = eventsPath ?? mpgEventsPath();
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const events: MpgSessionEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.session_id || !parsed.event_type || !parsed.timestamp) continue;
        events.push(parsed as MpgSessionEvent);
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Extract session ID from a Claude Code session file path.
 * Session files are named {session-id}.jsonl.
 */
export function sessionIdFromPath(sessionPath: string): string {
  return basename(sessionPath, ".jsonl");
}

/**
 * Correlate MPG events with a Claude Code session.
 * Matches by session_id = filename (minus .jsonl extension).
 * Returns null if no MPG events match this session.
 */
export function correlateMpgEvents(
  sessionPath: string | null,
  mpgEvents?: MpgSessionEvent[],
  eventsPath?: string
): CorrelatedMpgData | null {
  if (!sessionPath) return null;

  const events = mpgEvents ?? readMpgEvents(eventsPath);
  if (events.length === 0) return null;

  const sessionId = sessionIdFromPath(sessionPath);
  const matched = events.filter(e => e.session_id === sessionId);

  if (matched.length === 0) return null;

  return { sessionId, events: matched };
}
