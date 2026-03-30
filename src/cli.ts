import { runPulse, formatReport, savePulse } from "./commands/pulse.js";
import { runActivity } from "./commands/activity.js";
import { runHistory } from "./commands/history.js";
import { runTrend } from "./commands/trend.js";
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
      console.log(runActivity(args.slice(1)));
      break;
    case "history":
      handleHistory();
      break;
    case "trend":
      handleTrend();
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
  const runArgs = args.slice(1);
  const sessionPath = flagValue(runArgs, "--session");
  const projectDir = resolve(
    runArgs.find((a) => !a.startsWith("--") && a !== sessionPath) ||
      process.cwd()
  );

  if (sessionPath) {
    const resolved = resolve(sessionPath);
    const { existsSync } = await import("node:fs");
    if (!existsSync(resolved)) {
      console.error(`Session file not found: ${resolved}`);
      process.exit(1);
    }
  }

  if (args.includes("--no-llm")) {
    delete process.env.OPENAI_API_KEY;
  }

  const report = await runPulse(
    projectDir,
    sessionPath ? resolve(sessionPath) : undefined
  );
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

function handleHistory(): void {
  const historyArgs = args.slice(1);
  const projectDir = resolve(
    historyArgs.find((a) => !a.startsWith("--")) || process.cwd()
  );
  const opts = {
    range: flagValue(historyArgs, "--range"),
    json: historyArgs.includes("--json"),
  };
  console.log(runHistory(projectDir, opts));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function handleTrend(): void {
  const trendArgs = args.slice(1);
  const projectDir = resolve(
    trendArgs.find((a) => !a.startsWith("--")) || process.cwd()
  );
  const opts = {
    range: flagValue(trendArgs, "--range"),
    json: trendArgs.includes("--json"),
    metric: flagValue(trendArgs, "--metric"),
  };
  console.log(runTrend(projectDir, opts));
}

function printHelp(): void {
  console.log(`
pulse — agent interaction quality measurement

Usage:
  pulse [run] [path]     Run a pulse on the project (default: cwd)
  pulse activity <sub>   Session activity queries (sessions, summary, gc)
  pulse history [path]   Show saved pulse report history
  pulse trend [path]     Show metric trends over time
  pulse help             Show this help
  pulse version          Show version

Flags (run):
  --session <path>       Analyze a specific session JSONL file
  --json                 Also output raw JSON
  --no-save              Don't save pulse report to .pulse/
  --no-llm               Skip LLM-powered evaluations (prompt effectiveness)

Flags (history/trend):
  --range <N>d|h|m       Filter to reports within time range (e.g. 7d, 24h)
  --json                 Output as JSON array
  --metric <name>        Trend only: convergence, prompt, rework, leverage

Run "pulse activity" for activity subcommand help.
`.trim());
}

main();
