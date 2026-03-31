import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { anonymizeSession, runAnonymize } from "./anonymize.js";
import { runPulse } from "./pulse.js";

function makeLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "user",
    timestamp: "2026-03-27T10:00:00.000Z",
    message: { role: "user", content: "Fix the bug in /home/yamakei/project/src/auth.ts" },
    ...overrides,
  };
}

describe("anonymizeSession", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "pulse-anon-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("strips absolute file paths from user messages", () => {
    const session = join(tmpDir, "session.jsonl");
    writeFileSync(session, JSON.stringify(makeLine()) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    assert.ok(!parsed.message.content.includes("/home/yamakei"), "should not contain home path");
    assert.ok(!parsed.message.content.includes("auth.ts"), "should not contain filename");
    assert.ok(parsed.message.content.includes("file_"), "should contain file placeholder");
  });

  it("strips email addresses", () => {
    const session = join(tmpDir, "session.jsonl");
    const line = makeLine({ message: { role: "user", content: "Contact me at dev@example.com for details" } });
    writeFileSync(session, JSON.stringify(line) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    assert.ok(!parsed.message.content.includes("dev@example.com"), "should not contain email");
    assert.ok(parsed.message.content.includes("[email]"), "should contain email placeholder");
  });

  it("strips credentials and env vars", () => {
    const session = join(tmpDir, "session.jsonl");
    const line = makeLine({ message: { role: "user", content: "Set token=abc123secret and API_KEY=sk-12345" } });
    writeFileSync(session, JSON.stringify(line) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    assert.ok(!parsed.message.content.includes("abc123secret"), "should not contain token value");
    assert.ok(!parsed.message.content.includes("sk-12345"), "should not contain API key");
  });

  it("preserves message structure (type, role, timestamp)", () => {
    const session = join(tmpDir, "session.jsonl");
    writeFileSync(session, JSON.stringify(makeLine()) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, "user");
    assert.equal(parsed.message.role, "user");
    assert.ok(parsed.timestamp, "should have a timestamp");
  });

  it("preserves tool_use names and anonymizes file_path in input", () => {
    const session = join(tmpDir, "session.jsonl");
    const assistantLine = {
      type: "assistant",
      timestamp: "2026-03-27T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/home/yamakei/project/src/auth.ts", old_string: "const x = 1;", new_string: "const x = 2;" } },
          { type: "tool_use", name: "Bash", input: { command: "git commit -m \"fix: resolve auth bug (#12) because tokens were expiring\"" } },
        ],
        usage: { input_tokens: 5000, output_tokens: 3000 },
      },
    };
    writeFileSync(session, JSON.stringify(assistantLine) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    const blocks = parsed.message.content;

    // Tool name preserved
    assert.equal(blocks[0].name, "Edit");
    // File path anonymized
    assert.ok(!blocks[0].input.file_path.includes("/home/yamakei"), "should not contain real path");
    assert.ok(blocks[0].input.file_path.startsWith("file_"), "should have file placeholder");
    // Code content replaced
    assert.ok(blocks[0].input.old_string.includes("[code block"), "old_string should be anonymized");
    assert.ok(blocks[0].input.new_string.includes("[code block"), "new_string should be anonymized");

    // Bash commit: preserves issue ref and why-word
    assert.equal(blocks[1].name, "Bash");
    assert.ok(blocks[1].input.command.includes("#12"), "should preserve issue ref");
    assert.ok(blocks[1].input.command.includes("because"), "should preserve why-word");
    assert.ok(!blocks[1].input.command.includes("tokens were expiring"), "should strip description");
  });

  it("preserves token usage data", () => {
    const session = join(tmpDir, "session.jsonl");
    const line = {
      type: "assistant",
      timestamp: "2026-03-27T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 5000, output_tokens: 3000 },
      },
    };
    writeFileSync(session, JSON.stringify(line) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.message.usage.input_tokens, 5000);
    assert.equal(parsed.message.usage.output_tokens, 3000);
  });

  it("shifts timestamps to be relative", () => {
    const session = join(tmpDir, "session.jsonl");
    const line1 = makeLine({ timestamp: "2026-03-27T10:00:00.000Z" });
    const line2 = makeLine({ timestamp: "2026-03-27T10:05:00.000Z" });
    writeFileSync(session, [JSON.stringify(line1), JSON.stringify(line2)].join("\n") + "\n");
    const lines = anonymizeSession(session);
    const p1 = JSON.parse(lines[0]);
    const p2 = JSON.parse(lines[1]);
    // First timestamp should be epoch
    assert.equal(p1.timestamp, "1970-01-01T00:00:00.000Z");
    // Second should be 5 minutes later
    assert.equal(p2.timestamp, "1970-01-01T00:05:00.000Z");
  });

  it("uses deterministic path placeholders (same path → same placeholder)", () => {
    const session = join(tmpDir, "session.jsonl");
    const line1 = makeLine({ message: { role: "user", content: "Read /home/yamakei/project/src/auth.ts" } });
    const line2 = makeLine({ message: { role: "user", content: "Now edit /home/yamakei/project/src/auth.ts" }, timestamp: "2026-03-27T10:01:00.000Z" });
    writeFileSync(session, [JSON.stringify(line1), JSON.stringify(line2)].join("\n") + "\n");
    const lines = anonymizeSession(session);
    const p1 = JSON.parse(lines[0]);
    const p2 = JSON.parse(lines[1]);
    // Both should reference the same placeholder
    const placeholder1 = p1.message.content.match(/file_\d+/)?.[0];
    const placeholder2 = p2.message.content.match(/file_\d+/)?.[0];
    assert.ok(placeholder1, "first message should have file placeholder");
    assert.equal(placeholder1, placeholder2, "same path should get same placeholder");
  });

  it("preserves rework language patterns", () => {
    const session = join(tmpDir, "session.jsonl");
    const line = makeLine({ message: { role: "user", content: "That's not correct, undo the changes and try again." } });
    writeFileSync(session, JSON.stringify(line) + "\n");
    const lines = anonymizeSession(session);
    const parsed = JSON.parse(lines[0]);
    // Rework words preserved (no paths/PII in this message)
    assert.ok(parsed.message.content.includes("undo"), "should preserve 'undo'");
    assert.ok(parsed.message.content.includes("try again"), "should preserve 'try again'");
    assert.ok(parsed.message.content.includes("not correct"), "should preserve 'not correct'");
  });
});

describe("anonymizeSession completeness check", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "pulse-anon-complete-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("no raw paths leak through a realistic session", () => {
    const session = join(tmpDir, "session.jsonl");
    const lines = [
      { type: "user", timestamp: "2026-03-27T10:00:00.000Z", message: { role: "user", content: "Fix the bug in /home/yamakei/Documents/pulse/src/extractors/convergence.ts:42. The email for the author is dev@company.io and the server is api.prod.company.com." } },
      { type: "assistant", timestamp: "2026-03-27T10:02:00.000Z", message: { role: "assistant", content: [
        { type: "tool_use", name: "Read", input: { file_path: "/home/yamakei/Documents/pulse/src/extractors/convergence.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/home/yamakei/Documents/pulse/src/extractors/convergence.ts", old_string: "function foo() { return 1; }", new_string: "function foo() { return 2; }" } },
        { type: "tool_use", name: "Bash", input: { command: "git commit -m \"fix: correct convergence rate calculation (#30) because it was off by one\"" } },
      ], usage: { input_tokens: 8000, output_tokens: 5000 } } },
    ];
    writeFileSync(session, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = anonymizeSession(session);
    const fullOutput = result.join("\n");

    // No raw paths
    assert.ok(!fullOutput.includes("/home/yamakei"), "should not contain home path");
    assert.ok(!fullOutput.includes("convergence.ts"), "should not contain filename");
    // No emails
    assert.ok(!fullOutput.includes("dev@company.io"), "should not contain email");
    // No hostnames
    assert.ok(!fullOutput.includes("api.prod.company.com"), "should not contain hostname");
    // Issue refs preserved
    assert.ok(fullOutput.includes("#30"), "should preserve issue ref");
    // Why-words preserved
    assert.ok(fullOutput.includes("because"), "should preserve why-word");
  });
});

describe("fixture sessions are analyzable", () => {
  const fixturesDir = join(process.cwd(), "src", "commands", "fixtures");

  it("high-leverage fixture produces valid pulse report", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pulse-fixture-hl-"));
    try {
      const report = await runPulse(tmpDir, join(fixturesDir, "high-leverage.jsonl"));
      assert.ok(report.convergence.exchanges > 0, "should have exchanges");
      assert.ok(report.convergence.outcomes > 0, "should have outcomes");
      assert.ok(report.convergence.rate > 0, "should have a rate");
      assert.ok(report.tokenUsage.available, "should have token data");
      assert.ok(report.leverageScore >= 0 && report.leverageScore <= 1, "leverage score in range");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("high-rework fixture shows rework instances", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pulse-fixture-hr-"));
    try {
      const report = await runPulse(tmpDir, join(fixturesDir, "high-rework.jsonl"));
      assert.ok(report.convergence.reworkInstances > 0, "should detect rework");
      assert.ok(report.convergence.reworkPercent > 0, "should have rework %");
      assert.ok(report.convergence.exchanges >= 4, "should have multiple exchanges");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exploratory fixture classifies interaction pattern", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pulse-fixture-ex-"));
    try {
      const report = await runPulse(tmpDir, join(fixturesDir, "exploratory.jsonl"));
      assert.ok(report.convergence.exchanges > 0, "should have exchanges");
      assert.ok(["directive", "collaborative", "exploratory"].includes(report.interactionPattern.userStyle));
      assert.ok(report.tokenUsage.available, "should have token data");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runAnonymize", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "pulse-anon-cmd-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("shows usage with no arguments", () => {
    const output = runAnonymize([]);
    assert.ok(output.includes("Usage"));
  });

  it("outputs anonymized JSONL to stdout", () => {
    const session = join(tmpDir, "session.jsonl");
    writeFileSync(session, JSON.stringify(makeLine()) + "\n");
    const output = runAnonymize([session]);
    const parsed = JSON.parse(output);
    assert.equal(parsed.type, "user");
    assert.ok(!output.includes("/home/yamakei"));
  });

  it("writes to --output file", () => {
    const session = join(tmpDir, "session.jsonl");
    const outFile = join(tmpDir, "anon.jsonl");
    writeFileSync(session, JSON.stringify(makeLine()) + "\n");
    const output = runAnonymize([session, "--output", outFile]);
    assert.ok(output.includes("Anonymized"));
    const content = readFileSync(outFile, "utf-8");
    assert.ok(!content.includes("/home/yamakei"));
  });

  it("returns error for missing file", () => {
    const output = runAnonymize(["/nonexistent/path.jsonl"]);
    assert.ok(output.includes("Error"));
  });
});
