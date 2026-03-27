import { runPulse, formatReport, savePulse } from "./commands/pulse.js";
import { runActivity } from "./commands/activity.js";
import { runHistory } from "./commands/history.js";
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

function printHelp(): void {
  console.log(`
pulse — agent interaction quality measurement

Usage:
  pulse [run] [path]     Run a pulse on the project (default: cwd)
  pulse activity <sub>   Session activity queries (sessions, summary, gc)
  pulse history [path]   Show saved pulse report history
  pulse help             Show this help
  pulse version          Show version

Flags (run):
  --json                 Also output raw JSON
  --no-save              Don't save pulse report to .pulse/
  --no-llm               Skip LLM-powered evaluations (prompt effectiveness)

Flags (history):
  --range <N>d|h|m       Filter to reports within time range (e.g. 7d, 24h)
  --json                 Output as JSON array

Run "pulse activity" for activity subcommand help.
`.trim());
}

main();
