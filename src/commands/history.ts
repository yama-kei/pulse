import { PulseReport } from "../types/pulse.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadReports(projectDir: string): PulseReport[] {
  const pulseDir = join(projectDir, ".pulse");
  if (!existsSync(pulseDir)) return [];

  const files = readdirSync(pulseDir).filter((f) => f.startsWith("pulse-") && f.endsWith(".json"));
  const reports: PulseReport[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(pulseDir, file), "utf-8");
      reports.push(JSON.parse(raw) as PulseReport);
    } catch {
      // Skip malformed files
    }
  }

  reports.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return reports;
}
