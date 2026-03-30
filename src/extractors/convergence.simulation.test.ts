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
  /**
   * Recreates the actual bad session pattern:
   * 15 user messages, 6 commits all to #93, iterative fix-test-fail loop.
   *
   * BEFORE fix: rate=1.36, rework=13.3%, leverage=MEDIUM
   * AFTER fix: should show high rate, high rework, clearly LOW leverage
   */
  it("correctly scores the blind-retry session with new patterns", () => {
    const session = createRawSessionFile([
      // Message 0: initial report
      userMsg("Timeline chart does not render. Time range is super broad regardless of the time-period switch"),
      // Agent works, edits files, commits
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "a", new_string: "b" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): improve timeline chart visibility with thicker bars"' }),

      // Message 1: partial progress but not good enough
      userMsg("ok, timeline is now rendering, but it's kind of hard to see because line is very thin"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "b", new_string: "c" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): collapse timeline segments into single line"' }),

      // Message 2: commit instruction (not rework)
      userMsg("good. commit this change locally"),

      // Message 3: push instruction (not rework)
      userMsg("did you push to master?"),

      // Message 4: confirm (not rework)
      userMsg("yes, push to master (no PR)"),
      toolUseMsg("Bash", { command: 'git push origin master' }),

      // Message 5: more refinement requests
      userMsg("can we make the bar a single straight line for each session so timeline does not consume vertical space"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "c", new_string: "d" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): make timeline bars thicker"' }),

      // Message 6: more tweaks
      userMsg("make the line thicker, assuming that it won't largely impact the vertical space"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "d", new_string: "e" }),

      // Message 7: commit (not rework)
      userMsg("commit to local master branch"),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): fix timeline rendering"' }),

      // Message 8: REWORK - still expanding (present tense, not gerund)
      userMsg("when timeline graph is being rendered, it still expands vertically as it loads more data"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "e", new_string: "f" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): rewrite timeline with custom canvas plugin"' }),

      // Message 9: commit+push (not rework)
      userMsg("commit and push"),

      // Message 10: REWORK - not fixed
      userMsg("Not fixed even after I restart with latest changes. Can you go and check the website?"),

      // Message 11: checking (not rework)
      userMsg("is code pushed to master?"),

      // Message 12: REWORK - still expanding
      userMsg("OK, now I see green/grey display but the issue of graph automatically expands vertically as the page loads"),
      toolUseMsg("Edit", { file_path: "/tmp/dashboard-server.ts", old_string: "f", new_string: "g" }),
      toolUseMsg("Bash", { command: 'git commit -m "fix(#93): filter idle-only sessions and fix vertical expansion"' }),

      // Message 13: REWORK - got worse, pivot to diagnosis
      userMsg("No, it got worse...graphs are expanding even faster. Please investigate the cause and file an issue"),
      toolUseMsg("Bash", { command: 'gh issue create --title "Timeline chart vertical expansion" --body "root cause"' }),

      // Message 14: final instruction
      userMsg("commit and push what you have"),
    ]);

    const result = extractConvergence(session, 0);

    // Exchanges: 15 user messages
    assert.equal(result.exchanges, 15);

    // Rework: should catch "still expands", "Not fixed", "got worse"
    // Message 8: "still expands" -> matches /\bstill\s+(?:...expands?...)\b/
    // Message 10: "Not fixed" -> matches /\bnot\s+fixed\b/
    // Message 13: "got worse" -> matches /\bgot\s+worse\b/
    assert.ok(result.reworkInstances >= 3, `Expected >=3 rework, got ${result.reworkInstances}`);

    // Outcomes: 6 commits all to #93 should deduplicate to 1, plus 1 issue create
    // editedFiles: 1 unique file (/tmp/dashboard-server.ts)
    // commits with #93 refs: 6 -> deduplicated to 1
    // issues: 1
    // Total: 1 file + 1 deduped issue + 1 gh issue = 3
    assert.equal(result.outcomes, 3, `Expected 3 outcomes (1 file + 1 deduped issue + 1 gh issue), got ${result.outcomes}`);

    // Rate: 15 / 3 = 5.0 (high) — correctly identifies the problem
    assert.equal(result.rate, 5);

    // Rework %: should be well above the 15% nudge threshold
    assert.ok(result.reworkPercent >= 20, `Expected >=20% rework, got ${result.reworkPercent}`);
  });

  it("compares: concentrated blind-retry loop shows correct metrics", () => {
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

    // 4 exchanges
    assert.equal(result.exchanges, 4);

    // All 3 correction messages should be caught:
    // "not fixed" + "still shows" -> matches
    // "doesn't work" + "no change" -> matches
    // "got worse" -> matches
    assert.equal(result.reworkInstances, 3);
    assert.equal(result.reworkPercent, 75);

    // Outcomes: 1 file + 1 deduped #93 + 1 issue = 3
    assert.equal(result.outcomes, 3);

    // Rate: 4/3 = 1.33
    assert.equal(result.rate, 1.33);
  });
});
