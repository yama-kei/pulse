import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { MpgSessionEvent } from "../types/pulse.js";

export interface SessionFileInfo {
  sessionId: string;
  startTimestamp: string;
  endTimestamp: string;
  projectDir: string;
  messageCount: number;
}

export function scanSessionFile(filePath: string): SessionFileInfo | null {
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return null;

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    const firstParsed = JSON.parse(lines[0]);
    const lastParsed = lines.length > 1 ? JSON.parse(lines[lines.length - 1]) : firstParsed;

    const startTimestamp = firstParsed.timestamp;
    const endTimestamp = lastParsed.timestamp;
    if (!startTimestamp || !endTimestamp) return null;

    // Extract sessionId and cwd from first entry that has them
    let sessionId: string | undefined;
    let projectDir: string | undefined;
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
        if (!projectDir && parsed.cwd) projectDir = parsed.cwd;
        if (sessionId && projectDir) break;
      } catch {
        // skip
      }
    }

    // Fallback: session ID from filename
    if (!sessionId) {
      sessionId = basename(filePath, ".jsonl");
    }

    // Estimate user messages: count lines with "type":"user"
    let messageCount = 0;
    for (const line of lines) {
      if (line.includes('"type":"user"') || line.includes('"type": "user"')) {
        messageCount++;
      }
    }
    messageCount = Math.max(messageCount, 1);

    return {
      sessionId,
      startTimestamp,
      endTimestamp,
      projectDir: projectDir ?? "",
      messageCount,
    };
  } catch {
    return null;
  }
}

export interface ScanOptions {
  after?: Date;
  project?: string;
}

export function scanSessions(
  claudeProjectsDir: string,
  opts: ScanOptions = {}
): MpgSessionEvent[] {
  if (!existsSync(claudeProjectsDir)) return [];

  const events: MpgSessionEvent[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const dirName of projectDirs) {
    if (opts.project && dirName !== opts.project) continue;

    const fullDir = join(claudeProjectsDir, dirName);
    let files: string[];
    try {
      files = readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const info = scanSessionFile(join(fullDir, file));
      if (!info) continue;

      // Filter by date: skip sessions that ended before the cutoff
      if (opts.after && new Date(info.endTimestamp) < opts.after) continue;

      const projectKey = dirName;
      const projectDir = info.projectDir;

      events.push({
        schema_version: 1,
        timestamp: info.startTimestamp,
        event_type: "session_start",
        session_id: info.sessionId,
        project_key: projectKey,
        project_dir: projectDir,
      });

      for (let i = 0; i < info.messageCount; i++) {
        events.push({
          schema_version: 1,
          timestamp: info.startTimestamp,
          event_type: "message_routed",
          session_id: info.sessionId,
          project_key: projectKey,
          project_dir: projectDir,
        });
      }

      const durationMs = new Date(info.endTimestamp).getTime() - new Date(info.startTimestamp).getTime();
      events.push({
        schema_version: 1,
        timestamp: info.endTimestamp,
        event_type: "session_end",
        session_id: info.sessionId,
        project_key: projectKey,
        project_dir: projectDir,
        duration_ms: durationMs,
      });
    }
  }

  return events;
}
