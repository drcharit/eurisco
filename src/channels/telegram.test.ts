import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Test the splitText logic extracted as a pure function
function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  const MAX_CHUNKS = 10;

  for (let i = 0; i < MAX_CHUNKS && remaining.length > 0; i++) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const breakPoint = remaining.lastIndexOf("\n", maxLen);
    const splitAt = breakPoint > maxLen * 0.5 ? breakPoint : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

describe("splitText", () => {
  it("returns single chunk for short text", () => {
    const result = splitText("hello", 100);
    assert.equal(result.length, 1);
    assert.equal(result[0], "hello");
  });

  it("splits at newline boundary", () => {
    const text = "line1\nline2\nline3\nline4";
    const result = splitText(text, 14);
    assert.equal(result.length, 2);
    assert.equal(result[0], "line1\nline2");
    assert.equal(result[1], "\nline3\nline4");
  });

  it("hard splits when no good newline break", () => {
    const text = "a".repeat(200);
    const result = splitText(text, 100);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.length, 100);
    assert.equal(result[1]!.length, 100);
  });

  it("respects MAX_CHUNKS limit", () => {
    const text = Array.from({ length: 20 }, (_, i) => `chunk${i}`).join("\n");
    const result = splitText(text, 10);
    assert.ok(result.length <= 10);
  });

  it("handles empty string", () => {
    const result = splitText("", 100);
    assert.equal(result.length, 0);
  });
});
