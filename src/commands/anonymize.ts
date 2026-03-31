import { readFileSync, writeFileSync as fsWriteFile } from "node:fs";
import { createHash } from "node:crypto";

export interface AnonymizeOptions {
  output?: string;
}

interface SessionLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  [key: string]: unknown;
}

/** Stable hash for deduplication — same input always gets the same placeholder */
function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 8);
}

/**
 * Build a deterministic path map so the same file path always maps to the same
 * placeholder within a session.
 */
class PathMapper {
  private map = new Map<string, string>();
  private counter = 0;

  replace(path: string): string {
    let placeholder = this.map.get(path);
    if (!placeholder) {
      this.counter++;
      placeholder = `file_${String(this.counter).padStart(3, "0")}`;
      this.map.set(path, placeholder);
    }
    return placeholder;
  }
}

// Patterns for detecting file paths
const ABS_PATH_RE = /(?:\/[\w.\-]+){2,}/g;
const WIN_PATH_RE = /[A-Z]:\\(?:[\w.\-]+\\){1,}[\w.\-]+/g;

// Patterns for PII / sensitive data
const EMAIL_RE = /[\w.\-+]+@[\w.\-]+\.\w{2,}/g;
const USERNAME_RE = /\b(?:user|username|author|owner)[=: ]["']?[\w.\-]+["']?/gi;
const HOSTNAME_RE = /\b(?:[\w\-]+\.){2,}(?:com|org|net|io|dev|app|cloud)\b/g;
const ENV_VAR_RE = /(?:(?:export\s+)?[A-Z_]{2,}[A-Z0-9_]*\s*=\s*)\S+/g;
const CREDENTIAL_RE = /(?:(?:token|secret|password|key|apikey|api_key|auth)[=: ]["']?)\S+/gi;
const HOME_DIR_RE = /~\/[\w.\-/]+/g;

/**
 * Strip file paths from text, replacing with deterministic placeholders.
 */
function stripPaths(text: string, mapper: PathMapper): string {
  let result = text;
  // Replace absolute paths
  result = result.replace(ABS_PATH_RE, (match) => mapper.replace(match));
  // Replace Windows paths
  result = result.replace(WIN_PATH_RE, (match) => mapper.replace(match));
  // Replace home-relative paths
  result = result.replace(HOME_DIR_RE, (match) => mapper.replace(match));
  return result;
}

/**
 * Strip PII and sensitive data from text.
 */
function stripPii(text: string): string {
  let result = text;
  result = result.replace(EMAIL_RE, "[email]");
  result = result.replace(CREDENTIAL_RE, "[credential]");
  result = result.replace(ENV_VAR_RE, "[env_var]");
  result = result.replace(USERNAME_RE, "[username]");
  result = result.replace(HOSTNAME_RE, "[hostname]");
  return result;
}

/**
 * Anonymize a text block: strip paths, PII, preserve structure.
 */
function anonymizeText(text: string, mapper: PathMapper): string {
  let result = stripPaths(text, mapper);
  result = stripPii(result);
  return result;
}

/**
 * Anonymize code content — replace with length indicator.
 */
function anonymizeCode(code: string): string {
  const lineCount = code.split("\n").length;
  return `[code block, ${lineCount} lines]`;
}

/**
 * Anonymize a content block (text or tool_use).
 */
function anonymizeContentBlock(block: any, mapper: PathMapper): any {
  if (!block || typeof block !== "object") return block;

  if (block.type === "text") {
    return { ...block, text: anonymizeText(block.text || "", mapper) };
  }

  if (block.type === "tool_use") {
    const input: Record<string, unknown> = {};
    const rawInput = block.input || {};

    // Preserve tool name (needed for outcome counting)
    // Anonymize tool arguments
    if (block.name === "Write" || block.name === "Edit" || block.name === "Read") {
      if (typeof rawInput.file_path === "string") {
        input.file_path = mapper.replace(rawInput.file_path);
      }
      if (typeof rawInput.content === "string") {
        input.content = anonymizeCode(rawInput.content);
      }
      if (typeof rawInput.old_string === "string") {
        input.old_string = anonymizeCode(rawInput.old_string);
      }
      if (typeof rawInput.new_string === "string") {
        input.new_string = anonymizeCode(rawInput.new_string);
      }
    } else if (block.name === "Bash") {
      // Preserve commit structure for decision quality extraction
      const cmd = typeof rawInput.command === "string" ? rawInput.command : "";
      input.command = anonymizeBashCommand(cmd, mapper);
    } else if (block.name === "Grep" || block.name === "Glob") {
      if (typeof rawInput.path === "string") {
        input.path = mapper.replace(rawInput.path);
      }
      if (typeof rawInput.pattern === "string") {
        input.pattern = "[pattern]";
      }
    } else {
      // Unknown tool — strip all string values
      for (const [k, v] of Object.entries(rawInput)) {
        input[k] = typeof v === "string" ? "[redacted]" : v;
      }
    }

    return { type: "tool_use", name: block.name, input };
  }

  if (block.type === "tool_result") {
    return { type: "tool_result", content: "[result]" };
  }

  return block;
}

/**
 * Anonymize a bash command while preserving git commit structure.
 * Keeps: `git commit -m "fix(#N): ..."` structure with issue refs.
 * Strips: actual descriptions, paths, credentials.
 */
function anonymizeBashCommand(cmd: string, mapper: PathMapper): string {
  // Preserve git commit with message structure
  const commitMatch = cmd.match(/git\s+commit\s+-m\s+(?:"([^"]*?)"|'([^']*?)')/);
  if (commitMatch) {
    const msg = commitMatch[1] ?? commitMatch[2] ?? "";
    const anonymizedMsg = anonymizeCommitMessage(msg);
    return `git commit -m "${anonymizedMsg}"`;
  }

  // Preserve gh pr create structure
  if (/gh\s+pr\s+create/.test(cmd)) {
    return "gh pr create [args]";
  }
  if (/gh\s+issue\s+create/.test(cmd)) {
    return "gh issue create [args]";
  }

  // Generic bash — strip paths and PII
  let result = stripPaths(cmd, mapper);
  result = stripPii(result);
  return result;
}

/**
 * Anonymize a commit message while preserving structure for decision quality.
 * Keeps: type prefix (fix/feat/etc), issue refs (#N), why-words.
 * Strips: specific descriptions.
 */
function anonymizeCommitMessage(msg: string): string {
  // Extract conventional commit prefix
  const prefixMatch = msg.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*/);
  let prefix = "";
  if (prefixMatch) {
    const scope = prefixMatch[2] || "";
    const breaking = prefixMatch[3] || "";
    // Keep scope only if it's an issue ref
    const scopePart = /^#\d+$/.test(scope) ? `(${scope})` : "";
    prefix = `${prefixMatch[1]}${scopePart}${breaking}: `;
    msg = msg.slice(prefixMatch[0].length);
  }

  // Extract and preserve issue refs
  const issueRefs = msg.match(/#\d+/g) || [];
  const refSuffix = issueRefs.length > 0 ? ` (${issueRefs.join(", ")})` : "";

  // Preserve "why" indicator words
  const whyPatterns = /\b(because|so that|to prevent|to avoid|to ensure|in order to|this fixes|this resolves)\b/gi;
  const whyMatch = msg.match(whyPatterns);
  const whyHint = whyMatch ? ` [why: ${whyMatch[0].toLowerCase()}]` : "";

  return `${prefix}[description]${refSuffix}${whyHint}`;
}

/**
 * Shift timestamps to be relative (preserve gaps, anonymize absolute times).
 * Returns epoch-based timestamps starting from T=0.
 */
function shiftTimestamps(lines: SessionLine[]): void {
  let baseTime: number | null = null;
  for (const line of lines) {
    if (line.timestamp) {
      const t = new Date(line.timestamp).getTime();
      if (!isNaN(t)) {
        if (baseTime === null) baseTime = t;
        const offset = t - baseTime;
        // Use a fixed epoch + offset to preserve relative timing
        line.timestamp = new Date(offset).toISOString();
      }
    }
  }
}

/**
 * Anonymize a Claude Code session JSONL file.
 * Returns an array of anonymized JSONL strings.
 */
export function anonymizeSession(sessionPath: string): string[] {
  const content = readFileSync(sessionPath, "utf-8");
  const rawLines = content.split("\n").filter(Boolean);
  const mapper = new PathMapper();

  const parsed: SessionLine[] = [];
  for (const line of rawLines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  // Shift timestamps to relative
  shiftTimestamps(parsed);

  const result: string[] = [];
  for (const msg of parsed) {
    const anonymized = anonymizeLine(msg, mapper);
    result.push(JSON.stringify(anonymized));
  }

  return result;
}

function anonymizeLine(msg: SessionLine, mapper: PathMapper): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Preserve type and timestamp
  if (msg.type) out.type = msg.type;
  if (msg.timestamp) out.timestamp = msg.timestamp;

  if (msg.message) {
    const m: Record<string, unknown> = {};
    if (msg.message.role) m.role = msg.message.role;

    // Preserve usage for token counting
    if (msg.message.usage) {
      m.usage = { ...msg.message.usage };
    }

    // Anonymize content
    const content = msg.message.content;
    if (typeof content === "string") {
      m.content = anonymizeText(content, mapper);
    } else if (Array.isArray(content)) {
      m.content = content.map((block: any) => anonymizeContentBlock(block, mapper));
    }

    out.message = m;
  }

  return out;
}

/**
 * Run the anonymize command.
 */
export function runAnonymize(argv: string[]): string {
  const outputIdx = argv.indexOf("--output");
  const outputPath = outputIdx !== -1 && outputIdx + 1 < argv.length ? argv[outputIdx + 1] : undefined;

  // Skip flags to find positional session path
  const skipNext = new Set<number>();
  if (outputIdx !== -1) { skipNext.add(outputIdx); skipNext.add(outputIdx + 1); }

  const positional = argv.filter((a, i) => !skipNext.has(i) && !a.startsWith("--"));
  const sessionPath = positional[0];

  if (!sessionPath) {
    return "Usage: pulse anonymize <session-path> [--output <path>]";
  }

  try {
    const lines = anonymizeSession(sessionPath);
    const output = lines.join("\n") + "\n";

    if (outputPath) {
      fsWriteFile(outputPath, output);
      return `Anonymized ${lines.length} messages → ${outputPath}`;
    }

    return output.trimEnd();
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
}
