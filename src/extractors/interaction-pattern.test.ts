import { extractInteractionPattern, computeHandoffPatterns } from "./interaction-pattern.js";
import { writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { CorrelatedMpgData, MpgSessionEvent } from "../types/pulse.js";

let tmpFiles: string[] = [];
let tmpDirs: string[] = [];

function createSessionFile(messages: Array<{ type: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "pulse-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, "session.jsonl");
  const lines = messages.map(m =>
    JSON.stringify({
      type: m.type,
      message: { role: m.type === "user" ? "user" : "assistant", content: m.content },
    })
  );
  writeFileSync(filePath, lines.join("\n") + "\n");
  tmpFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  for (const d of tmpDirs) { try { rmdirSync(d); } catch {} }
  tmpFiles = [];
  tmpDirs = [];
});

describe("interaction-pattern extractor", () => {
  it("returns defaults when no session file", () => {
    const result = extractInteractionPattern(null);
    assert.equal(result.userStyle, "directive");
    assert.equal(result.contextProvision, "vague");
    assert.ok(result.observation.includes("No session data"));
  });

  it("classifies directive style", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the login bug" },
      { type: "assistant", content: "done" },
      { type: "user", content: "add error handling" },
      { type: "assistant", content: "done" },
      { type: "user", content: "deploy to staging" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.userStyle, "directive");
  });

  it("classifies collaborative style", () => {
    const session = createSessionFile([
      { type: "user", content: "what if we used a queue instead of polling?" },
      { type: "assistant", content: "that could work" },
      { type: "user", content: "let's try that approach, I think it would be cleaner" },
      { type: "assistant", content: "implementing" },
      { type: "user", content: "how about we also add a fallback option?" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.userStyle, "collaborative");
  });

  it("classifies exploratory style", () => {
    const session = createSessionFile([
      { type: "user", content: "why does this function return null?" },
      { type: "assistant", content: "because..." },
      { type: "user", content: "how does the auth middleware work?" },
      { type: "assistant", content: "it checks..." },
      { type: "user", content: "explain the caching strategy" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.userStyle, "exploratory");
  });

  it("classifies structured context provision", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the bug in src/auth.ts:42 per #123" },
      { type: "assistant", content: "on it" },
      { type: "user", content: "```typescript\nconst x = 1;\n```\nuse this pattern" },
      { type: "assistant", content: "done" },
      { type: "user", content: "see https://docs.example.com for the spec" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.contextProvision, "structured");
  });

  it("classifies vague context provision for short messages", () => {
    const session = createSessionFile([
      { type: "user", content: "fix it" },
      { type: "assistant", content: "what?" },
      { type: "user", content: "the bug" },
      { type: "assistant", content: "which one?" },
      { type: "user", content: "the one from yesterday" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.contextProvision, "vague");
  });

  it("generates observation with message stats", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the login bug" },
      { type: "user", content: "add tests too" },
    ]);
    const result = extractInteractionPattern(session);
    assert.ok(result.observation.includes("2 user messages"));
    assert.ok(result.observation.includes("avg"));
  });

  it("filters out system/skill messages from classification", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the login bug" },
      { type: "user", content: "Base directory for this skill: /home/user/.claude/plugins/cache/superpowers/skills/stop" },
      { type: "user", content: "add error handling" },
      { type: "user", content: "something about /.claude/plugins/ wrong path" },
    ]);
    const result = extractInteractionPattern(session);
    // Only 2 real messages counted, both directive
    assert.equal(result.userStyle, "directive");
    assert.ok(result.observation.includes("2 user messages"));
  });

  it("ignores assistant messages in classification", () => {
    const session = createSessionFile([
      { type: "assistant", content: "what if we used a different approach?" },
      { type: "user", content: "fix it" },
      { type: "assistant", content: "let's discuss alternatives" },
      { type: "user", content: "just do it" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.userStyle, "directive");
  });

  it("returns no handoffs when mpgData is undefined", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the bug" },
    ]);
    const result = extractInteractionPattern(session);
    assert.equal(result.handoffs, undefined);
  });

  it("returns no handoffs when mpgData has no handoff events", () => {
    const session = createSessionFile([
      { type: "user", content: "fix the bug" },
    ]);
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "message_routed", session_id: "test", project_key: "t", project_dir: "/t", agent_target: "engineer" },
      ],
    };
    const result = extractInteractionPattern(session, mpgData);
    assert.equal(result.handoffs, undefined);
  });

  it("computes handoff patterns from agent_handoff events", () => {
    const session = createSessionFile([
      { type: "user", content: "implement the feature" },
    ]);
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "agent_handoff", session_id: "test", project_key: "t", project_dir: "/t", from_agent: "pm", to_agent: "engineer" },
        { schema_version: 1, timestamp: "2026-03-30T10:01:00Z", event_type: "agent_handoff", session_id: "test", project_key: "t", project_dir: "/t", from_agent: "engineer", to_agent: "qa" },
        { schema_version: 1, timestamp: "2026-03-30T10:02:00Z", event_type: "agent_handoff", session_id: "test", project_key: "t", project_dir: "/t", from_agent: "pm", to_agent: "engineer" },
      ],
    };
    const result = extractInteractionPattern(session, mpgData);
    assert.ok(result.handoffs);
    assert.equal(result.handoffs!.totalHandoffs, 3);
    assert.equal(result.handoffs!.handoffPairs.length, 2);
    assert.equal(result.handoffs!.pattern, "pipeline");

    const pmToEng = result.handoffs!.handoffPairs.find(p => p.from === "pm" && p.to === "engineer");
    assert.ok(pmToEng);
    assert.equal(pmToEng!.count, 2);
  });
});

describe("handoff pattern classification", () => {
  function makeHandoff(from: string, to: string): MpgSessionEvent {
    return {
      schema_version: 1,
      timestamp: "2026-03-30T10:00:00Z",
      event_type: "agent_handoff",
      session_id: "test",
      project_key: "t",
      project_dir: "/t",
      from_agent: from,
      to_agent: to,
    };
  }

  it("classifies pipeline pattern (linear flow)", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        makeHandoff("pm", "engineer"),
        makeHandoff("engineer", "qa"),
        makeHandoff("pm", "engineer"),
      ],
    };
    const result = computeHandoffPatterns(mpgData);
    assert.ok(result);
    assert.equal(result!.pattern, "pipeline");
  });

  it("classifies iterative pattern (back-and-forth)", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        makeHandoff("pm", "engineer"),
        makeHandoff("engineer", "pm"),
        makeHandoff("pm", "engineer"),
        makeHandoff("engineer", "pm"),
      ],
    };
    const result = computeHandoffPatterns(mpgData);
    assert.ok(result);
    assert.equal(result!.pattern, "iterative");
  });

  it("handles user-initiated handoffs (missing from_agent)", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "agent_handoff", session_id: "test", project_key: "t", project_dir: "/t", to_agent: "engineer" },
        makeHandoff("engineer", "qa"),
      ],
    };
    const result = computeHandoffPatterns(mpgData);
    assert.ok(result);
    assert.equal(result!.totalHandoffs, 2);
    const userToEng = result!.handoffPairs.find(p => p.from === "user" && p.to === "engineer");
    assert.ok(userToEng);
    assert.equal(userToEng!.count, 1);
  });

  it("falls back to legacy agent_source/agent_target fields", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "agent_handoff", session_id: "test", project_key: "t", project_dir: "/t", agent_source: "pm", agent_target: "engineer" },
      ],
    };
    const result = computeHandoffPatterns(mpgData);
    assert.ok(result);
    assert.equal(result!.handoffPairs[0].from, "pm");
    assert.equal(result!.handoffPairs[0].to, "engineer");
  });

  it("returns null when no handoff events exist", () => {
    const mpgData: CorrelatedMpgData = {
      sessionId: "test",
      events: [
        { schema_version: 1, timestamp: "2026-03-30T10:00:00Z", event_type: "message_routed", session_id: "test", project_key: "t", project_dir: "/t" },
      ],
    };
    const result = computeHandoffPatterns(mpgData);
    assert.equal(result, null);
  });
});
