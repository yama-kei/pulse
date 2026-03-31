import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { extractConvergence } from "./convergence.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createRawSessionFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-sim-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

function toolUseMsg(toolName: string, input: Record<string, unknown>): object {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: toolName, input }],
    },
  };
}

function userMsg(text: string): object {
  return { type: "user", message: { role: "user", content: text } };
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of tmpDirs) { try { rmdirSync(d); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

describe("simulation: timeline chart blind-retry session (mpg #93)", () => {
  it("correctly scores the blind-retry session with new patterns", () => {
    const session = createRawSessionFile([
      userMsg("Timeline chart does not render. Time range is super broad regardless of the time-period switch"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "a", new_string: "b" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): improve timeline chart visibility with thicker bars"' }),
      userMsg("ok, timeline is now rendering, but it's kind of hard to see because line is very thin"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "b", new_string: "c" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): collapse timeline segments into single line"' }),
      userMsg("good. commit this change locally"),
      userMsg("did you push to master?"),
      userMsg("yes, push to master (no PR)"),
      toolUseMsg("Bash", { command: 'git push origin master' }),
      userMsg("can we make the bar a single straight line for each session so timeline does not consume vertical space"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "c", new_string: "d" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): make timeline bars thicker"' }),
      userMsg("make the line thicker, assuming that it won't largely impact the vertical space"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "d", new_string: "e" }),
      userMsg("commit to local master branch"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): fix timeline rendering"' }),
      // REWORK: still expands
      userMsg("when timeline graph is being rendered, it still expands vertically as it loads more data"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "e", new_string: "f" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): rewrite timeline with custom canvas plugin"' }),
      userMsg("commit and push"),
      // REWORK: not fixed
      userMsg("Not fixed even after I restart with latest changes. Can you go and check the website?"),
      userMsg("is code pushed to master?"),
      // REWORK: still expanding
      userMsg("OK, now I see green/grey display but the issue of graph automatically expands vertically as the page loads"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "f", new_string: "g" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): filter idle-only sessions and fix vertical expansion"' }),
      // REWORK + PIVOT: got worse, asks to investigate and file issue
      userMsg("No, it got worse...graphs are expanding even faster. Please investigate the cause and file an issue"),
      toolUseMsg("Bash", { command: 'gh issue create --title "Timeline chart vertical expansion" --body "root cause"' }),
      userMsg("commit and push what you have"),
    ]);

    const result = extractConvergence(session, 0);

    assert.equal(result.exchanges, 15);
    assert.ok(result.reworkInstances >= 3, `Expected >=3 rework, got ${result.reworkInstances}`);
    assert.equal(result.outcomes, 3);
    assert.equal(result.rate, 5);
    assert.ok(result.reworkPercent >= 20, `Expected >=20% rework, got ${result.reworkPercent}`);

    // Blind retries: consecutive rework without diagnosis
    assert.ok(result.blindRetries >= 2, `Expected >=2 blind retries, got ${result.blindRetries}`);

    // Pivot: user asked to "investigate the cause and file an issue"
    assert.ok(result.pivot !== null, "Expected pivot to be detected");
    assert.ok(result.pivot!.fixAttemptsBefore >= 2, `Expected >=2 fix attempts before pivot, got ${result.pivot!.fixAttemptsBefore}`);
  });

  it("compact blind-retry: 3 fix-fail cycles then pivot", () => {
    const session = createRawSessionFile([
      userMsg("fix the rendering"),
      toolUseMsg("Edit", { file_path: "/tmp/chart.ts", old_string: "a", new_string: "b" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 1"' }),
      userMsg("not fixed, the chart still shows the same problem"),
      toolUseMsg("Edit", { file_path: "/tmp/chart.ts", old_string: "b", new_string: "c" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 2"' }),
      userMsg("doesn't work, no change at all"),
      toolUseMsg("Edit", { file_path: "/tmp/chart.ts", old_string: "c", new_string: "d" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): attempt 3"' }),
      userMsg("got worse. investigate the root cause and file an issue"),
      toolUseMsg("Bash", { command: 'gh issue create --title "investigate root cause"' }),
    ]);

    const result = extractConvergence(session, 0);

    assert.equal(result.exchanges, 4);
    assert.equal(result.reworkInstances, 3);
    assert.equal(result.reworkPercent, 75);
    assert.equal(result.outcomes, 3);

    assert.equal(result.blindRetries, 2);
    assert.ok(result.pivot !== null, "Expected pivot");
    assert.equal(result.pivot!.type, "issue_creation");
    assert.ok(result.pivot!.fixAttemptsBefore >= 2);
  });
});

describe("blind-retry detection", () => {
  it("returns 0 for a clean session with no rework", () => {
    const session = createRawSessionFile([
      userMsg("add a login form"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("now add validation"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
      userMsg("looks good, commit"),
      toolUseMsg("Bash", { command: 'git commit -m "feat: add login form"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.blindRetries, 0);
  });

  it("returns 0 when rework is followed by diagnosis, not more rework", () => {
    const session = createRawSessionFile([
      userMsg("fix the chart"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("not fixed"),
      userMsg("why is this happening? check the console logs"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.blindRetries, 0);
  });

  it("counts consecutive rework without diagnosis as blind retries", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("still broken"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
      userMsg("still not working"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "c", new_string: "d" }),
      userMsg("same issue, no change"),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.blindRetries, 2);
  });

  it("resets count when diagnostic message interrupts the chain", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("still broken"),
      userMsg("explain why this is failing"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
      userMsg("still not working"),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.blindRetries, 0);
  });
});

describe("pivot detection", () => {
  it("returns null for clean sessions without pivots", () => {
    const session = createRawSessionFile([
      userMsg("add a feature"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("commit and push"),
      toolUseMsg("Bash", { command: 'git commit -m "feat: something"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.pivot, null);
  });

  it("returns null if issue creation happens without prior rework", () => {
    const session = createRawSessionFile([
      userMsg("create an issue for the new feature"),
      toolUseMsg("Bash", { command: 'gh issue create --title "new feature"' }),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.pivot, null);
  });

  it("detects pivot to issue creation after rework", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("not fixed"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
      userMsg("still broken"),
      userMsg("file an issue to track this"),
    ]);
    const result = extractConvergence(session, 0);
    assert.ok(result.pivot !== null, "Expected pivot");
    assert.equal(result.pivot!.type, "issue_creation");
    assert.ok(result.pivot!.fixAttemptsBefore >= 2);
  });

  it("detects pivot to root cause request after rework", () => {
    const session = createRawSessionFile([
      userMsg("fix the chart rendering"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("not working"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "b", new_string: "c" }),
      userMsg("same problem"),
      userMsg("investigate the root cause before trying another fix"),
    ]);
    const result = extractConvergence(session, 0);
    assert.ok(result.pivot !== null, "Expected pivot");
    assert.equal(result.pivot!.type, "root_cause_request");
    assert.ok(result.pivot!.fixAttemptsBefore >= 2);
  });

  it("does not detect pivot if diagnostic resets the chain", () => {
    const session = createRawSessionFile([
      userMsg("fix the bug"),
      toolUseMsg("Edit", { file_path: "/tmp/a.ts", old_string: "a", new_string: "b" }),
      userMsg("not fixed"),
      userMsg("why is this happening? check the error logs"),
      userMsg("ok I see, create an issue for the deeper fix"),
    ]);
    const result = extractConvergence(session, 0);
    assert.equal(result.pivot, null);
  });
});
