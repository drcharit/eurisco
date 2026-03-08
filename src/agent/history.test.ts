import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initHistory, addToHistory, getHistory, clearHistory, pruneToolResults } from "./history.js";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dirname, "..", "..", "test-tmp-history");

describe("history", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    clearHistory();
    initHistory(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("starts empty", () => {
    assert.equal(getHistory().length, 0);
  });

  it("adds and retrieves entries", () => {
    addToHistory({ role: "user", parts: [{ text: "hello" }] });
    addToHistory({ role: "model", parts: [{ text: "hi" }] });
    assert.equal(getHistory().length, 2);
  });

  it("persists to disk", () => {
    addToHistory({ role: "user", parts: [{ text: "test" }] });
    const filePath = resolve(TEST_DIR, "conversation.jsonl");
    assert.ok(existsSync(filePath));
    const content = readFileSync(filePath, "utf-8");
    assert.ok(content.includes("test"));
  });

  it("reloads from disk", () => {
    addToHistory({ role: "user", parts: [{ text: "persist me" }] });
    addToHistory({ role: "model", parts: [{ text: "ok" }] });

    // Re-init to simulate restart
    initHistory(TEST_DIR);
    const h = getHistory();
    assert.equal(h.length, 2);
    assert.equal((h[0]!.parts[0] as { text: string }).text, "persist me");
  });

  it("clears history", () => {
    addToHistory({ role: "user", parts: [{ text: "gone" }] });
    clearHistory();
    assert.equal(getHistory().length, 0);
  });

  it("prunes old tool results", () => {
    // Add enough entries so pruning kicks in
    for (let i = 0; i < 15; i++) {
      addToHistory({ role: "user", parts: [{ text: `msg ${i}` }] });
    }

    // Add an old tool result with long output
    const longResult = "x".repeat(2000);
    const entry = {
      role: "user" as const,
      parts: [{
        functionResponse: {
          name: "test",
          response: { result: longResult },
        },
      }],
    };
    // Insert at beginning (old position)
    const h = getHistory();
    h.unshift(entry);

    // Manually set history for test
    clearHistory();
    initHistory(TEST_DIR);
    addToHistory(entry);
    for (let i = 0; i < 15; i++) {
      addToHistory({ role: "user", parts: [{ text: `msg ${i}` }] });
    }

    pruneToolResults();
    const pruned = getHistory();
    const firstPart = pruned[0]!.parts[0] as { functionResponse: { response: { result: string } } };
    assert.ok(firstPart.functionResponse.response.result.length < 2000);
    assert.ok(firstPart.functionResponse.response.result.includes("pruned"));
  });
});
