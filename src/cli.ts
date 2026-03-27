import { runPulse, formatReport, savePulse } from "./commands/pulse.js";
import { runActivitySessions, runActivitySummary, runActivityGc } from "./commands/activity.js";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const command = args[0] || "run";

function main(): void {
  switch (command) {
    case "run":
    case undefined:
      run().catch((err) => {
        console.error(err.message);
        process.exit(1);
      });
      break;
    case "activity":
      activity();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log("pulse 0.1.0");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function run(): Promise<void> {
  const projectDir = resolve(args[1] || process.cwd());

  if (args.includes("--no-llm")) {
    delete process.env.OPENAI_API_KEY;
  }

  const report = await runPulse(projectDir);
  console.log(formatReport(report));
  console.log("");

  const jsonFlag = args.includes("--json");
  if (jsonFlag) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const noSave = args.includes("--no-save");
  if (!noSave) {
    const saved = savePulse(projectDir, report);
    console.log(`Saved to ${saved}`);
  }
}

function activity(): void {
  const subcommand = args[1];
  const subArgs = args.slice(2);

  switch (subcommand) {
    case "sessions":
      runActivitySessions(subArgs);
      break;
    case "summary":
      runActivitySummary(subArgs);
      break;
    case "gc":
      runActivityGc(subArgs);
      break;
    default:
      console.error(`Unknown activity subcommand: ${subcommand || "(none)"}`);
      console.log("\nUsage:");
      console.log("  pulse activity sessions  [--source X] [--range 7d] [--project X] [--type X] [--json]");
      console.log("  pulse activity summary   [--source X] [--range 7d] [--project X] [--bucket day] [--json]");
      console.log("  pulse activity gc        [--source X] [--retention 30d] [--dry-run]");
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
pulse — agent interaction quality measurement

Usage:
  pulse [run] [path]     Run a pulse on the project (default: cwd)
  pulse activity sessions [flags]  List session events
  pulse activity summary  [flags]  Aggregated activity stats
  pulse activity gc       [flags]  Remove old events
  pulse help             Show this help
  pulse version          Show version

Run flags:
  --json                 Also output raw JSON
  --no-save              Don't save pulse report to .pulse/
  --no-llm               Skip LLM-powered evaluations (prompt effectiveness)

Activity flags:
  --source NAME          Event source (default: mpg-sessions)
  --range DURATION       Time range: 24h, 7d, 30d (default: 7d)
  --project KEY          Filter by project key
  --type TYPE            Filter by event type (sessions only)
  --bucket SIZE          Bucket: hour, day, week (summary only, default: day)
  --json                 Output raw JSON
  --retention DURATION   Retention period (gc only, default: 30d)
  --dry-run              Show what gc would remove`.trim());
}

main();
