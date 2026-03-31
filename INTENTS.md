# System Intents

## I-001: Transparent Scoring
**Status:** Earned

All metrics computed from observable data (git history, session logs, file patterns). No hidden scoring layers or opaque heuristics. Users see everything Pulse computes and can trace any score back to its inputs.

### Goal
Every score Pulse produces is traceable to observable inputs (git commits, session JSONL fields, file presence). No metric requires trust in an opaque model.

### Success Criteria
- All extractor functions take raw data and return typed signals
- No scoring logic depends on external LLM output (prompt effectiveness is optional and clearly labeled)
- `formatReport()` displays every computed value

### Risk Signals
- Adding a metric that cannot be explained from its inputs
- Introducing scoring weights that are not visible in the report

## I-002: Read-Only Observation
**Status:** Earned

Pulse observes and reports. It never modifies project files, intents, or session behavior during analysis. The only writes are to `.pulse/` report output and stdout.

### Goal
Running `pulse` is always safe — it cannot alter source code, git history, or session state.

### Success Criteria
- No extractor calls `writeFileSync`, `execSync` with mutating commands, or modifies files outside `.pulse/`
- `savePulse()` is the only write operation and targets `.pulse/` exclusively

### Risk Signals
- An extractor or command that writes to the project directory
- A `git` command in an extractor that is not read-only

## I-003: Graceful Degradation
**Status:** Earned

Missing files, non-git directories, or unavailable services (e.g. no LLM API key) produce zero/empty signals, never errors. Every extractor works standalone without dependencies on other extractors.

### Goal
Pulse runs in any directory without crashing. Partial data yields partial results, not failures.

### Success Criteria
- Every extractor has a try/catch that returns a zero/empty signal on failure
- `runPulse()` completes even when session file is null, git is absent, or LLM key is missing
- No extractor throws an unhandled exception

### Risk Signals
- An extractor that crashes on missing input
- A required dependency between extractors

## I-004: Zero Production Dependencies
**Status:** Earned

No runtime dependencies. Only TypeScript and @types/node as dev dependencies. This keeps the tool lightweight and auditable.

### Goal
`npm install --production` installs nothing. The compiled JS runs on bare Node.js.

### Success Criteria
- `package.json` has zero `dependencies` (only `devDependencies`)
- All functionality uses Node.js built-in modules

### Risk Signals
- Adding a package to `dependencies` in `package.json`
- Importing a module that requires installation

## I-005: Privacy-First Analysis
**Status:** Earned

Session data stays local in `.pulse/`. The anonymizer strips file paths, code content, PII, and credentials before any data leaves the machine. No cloud storage, no telemetry.

### Goal
Users can run Pulse with confidence that their session data, code, and identifiers remain on their machine.

### Success Criteria
- Reports saved only to local `.pulse/` directory
- `pulse anonymize` strips all file paths, code, emails, credentials, and hostnames
- No network calls except optional LLM evaluation (which sends only user message text, not code)

### Risk Signals
- Adding telemetry or cloud upload
- An anonymizer bypass that leaks file paths or PII

## Signals

Recorded under `intentlayer/signals/`.

## Audits

Recorded under `intentlayer/audits/`.
