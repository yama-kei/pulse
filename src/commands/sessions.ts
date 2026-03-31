import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { scanSessionFile, SessionFileInfo } from "../activity/session-scanner.js";
import { parseRange } from "../activity/range.js";

/** Regex to extract worktree ID and optional agent role from directory names.
 * Directories are encoded as e.g. "-home-user-proj--worktrees-12345-engineer"
 * (the `.worktrees` dir becomes `--worktrees` due to path encoding). */
const WORKTREE_RE = /-worktrees-(\d+)(?:-(pm|engineer))?$/;

export interface SessionEntry {
  role: string;
  messageCount: number;
  startTimestamp: string;
  endTimestamp: string;
  filePath: string;
  dirName: string;
}

export interface ThreadGroup {
  worktreeId: string;
  project: string;
  sessions: SessionEntry[];
  latestTimestamp: string;
}

export interface SessionsOptions {
  range?: string;
  json?: boolean;
}

/**
 * Extract worktree ID and agent role from a Claude projects directory name.
 * Returns null for non-worktree directories.
 */
export function extractWorktreeInfo(dirName: string): { worktreeId: string; role: string } | null {
  const match = dirName.match(WORKTREE_RE);
  if (!match) return null;
  return { worktreeId: match[1], role: match[2] || "main" };
}

/**
 * Extract a human-readable project name from a directory name.
 * E.g. "-home-yamakei-Documents-pulse--worktrees-12345-engineer" → "pulse"
 */
export function extractProjectName(dirName: string): string {
  // Strip the worktree suffix first
  const base = dirName.replace(/-worktrees-\d+(?:-(pm|engineer))?$/, "");
  // The project name is the last path segment (split on - but path segments are separated by single -)
  const parts = base.split("-").filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

/**
 * Scan all Claude Code sessions and group by worktree ID.
 */
export function discoverThreads(opts: SessionsOptions = {}): ThreadGroup[] {
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjectsDir)) return [];

  const after = opts.range ? parseRange(opts.range) : parseRange("7d");

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const threadMap = new Map<string, ThreadGroup>();
  const standalone: ThreadGroup[] = [];

  for (const dirName of projectDirs) {
    const fullDir = join(claudeProjectsDir, dirName);
    let files: string[];
    try {
      files = readdirSync(fullDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    const wtInfo = extractWorktreeInfo(dirName);

    for (const file of files) {
      const filePath = join(fullDir, file);
      const info = scanSessionFile(filePath);
      if (!info) continue;

      // Filter by time range
      if (new Date(info.endTimestamp) < after) continue;

      const entry: SessionEntry = {
        role: wtInfo?.role || "standalone",
        messageCount: info.messageCount,
        startTimestamp: info.startTimestamp,
        endTimestamp: info.endTimestamp,
        filePath,
        dirName,
      };

      if (wtInfo) {
        let group = threadMap.get(wtInfo.worktreeId);
        if (!group) {
          group = {
            worktreeId: wtInfo.worktreeId,
            project: extractProjectName(dirName),
            sessions: [],
            latestTimestamp: info.endTimestamp,
          };
          threadMap.set(wtInfo.worktreeId, group);
        }
        group.sessions.push(entry);
        if (info.endTimestamp > group.latestTimestamp) {
          group.latestTimestamp = info.endTimestamp;
        }
      } else {
        standalone.push({
          worktreeId: "",
          project: extractProjectName(dirName),
          sessions: [entry],
          latestTimestamp: info.endTimestamp,
        });
      }
    }
  }

  // Combine and sort by most recent activity
  const all = [...threadMap.values(), ...standalone];
  all.sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp));

  // Sort sessions within each group by start time
  for (const group of all) {
    group.sessions.sort((a, b) => a.startTimestamp.localeCompare(b.startTimestamp));
  }

  return all;
}

export function formatSessions(groups: ThreadGroup[]): string {
  if (groups.length === 0) {
    return "No sessions found. Sessions are discovered from ~/.claude/projects/";
  }

  const lines: string[] = [];

  for (const group of groups) {
    const earliest = group.sessions[0]?.startTimestamp;
    const latest = group.latestTimestamp;
    const dateRange = `${formatTime(earliest)}\u2013${formatTime(latest)}`;

    if (group.worktreeId) {
      lines.push(`Thread ${group.worktreeId} (${group.project}) \u2014 ${formatDate(earliest)} ${dateRange}`);
    } else {
      lines.push(`${group.project} (standalone) \u2014 ${formatDate(earliest)} ${dateRange}`);
    }

    for (const s of group.sessions) {
      const role = s.role.padEnd(10);
      const msgs = `${s.messageCount} msgs`.padEnd(10);
      const range = `${formatTime(s.startTimestamp)}\u2013${formatTime(s.endTimestamp)}`;
      lines.push(`  ${role} ${msgs} ${range}  ${s.filePath}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function runSessions(argv: string[]): string {
  const rangeIdx = argv.indexOf("--range");
  const range = rangeIdx !== -1 && rangeIdx + 1 < argv.length ? argv[rangeIdx + 1] : undefined;
  const json = argv.includes("--json");

  const groups = discoverThreads({ range });

  if (json) {
    return JSON.stringify(groups, null, 2);
  }

  return formatSessions(groups);
}
