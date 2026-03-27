import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseRange } from "./range.js";

describe("parseRange", () => {
  it("parses days", () => {
    const now = new Date("2026-03-27T12:00:00Z");
    const start = parseRange("7d", now);
    assert.deepStrictEqual(start, new Date("2026-03-20T12:00:00Z"));
  });

  it("parses hours", () => {
    const now = new Date("2026-03-27T12:00:00Z");
    const start = parseRange("24h", now);
    assert.deepStrictEqual(start, new Date("2026-03-26T12:00:00Z"));
  });

  it("parses minutes", () => {
    const now = new Date("2026-03-27T12:00:00Z");
    const start = parseRange("30m", now);
    assert.deepStrictEqual(start, new Date("2026-03-27T11:30:00Z"));
  });

  it("throws on invalid format", () => {
    assert.throws(() => parseRange("abc", new Date()), /Invalid range/);
  });

  it("throws on zero value", () => {
    assert.throws(() => parseRange("0d", new Date()), /Invalid range/);
  });
});
