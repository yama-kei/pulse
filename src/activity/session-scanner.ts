import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

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
