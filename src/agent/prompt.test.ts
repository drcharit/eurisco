import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./prompt.js";
import { MarkdownMemory } from "../memory/markdown.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dirname, "..", "..", "test-tmp-prompt");

describe("buildSystemPrompt", () => {
  let memory: MarkdownMemory;

  beforeEach(() => {
    mkdirSync(resolve(TEST_DIR, "memory"), { recursive: true });
    memory = new MarkdownMemory(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("includes default soul when SOUL.md missing", () => {
    const prompt = buildSystemPrompt(memory);
    assert.ok(prompt.includes("Kit"));
    assert.ok(prompt.includes("personal AI system"));
  });

  it("includes SOUL.md content when present", () => {
    writeFileSync(resolve(TEST_DIR, "SOUL.md"), "You are TestBot.");
    const prompt = buildSystemPrompt(memory);
    assert.ok(prompt.includes("You are TestBot."));
  });

  it("includes today's date", () => {
    const prompt = buildSystemPrompt(memory);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(prompt.includes(today));
  });

  it("includes long-term memory when present", () => {
    writeFileSync(resolve(TEST_DIR, "MEMORY.md"), "User prefers dark mode.");
    const prompt = buildSystemPrompt(memory);
    assert.ok(prompt.includes("User prefers dark mode."));
    assert.ok(prompt.includes("Long-Term Memory"));
  });

  it("includes daily log when present", () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(resolve(TEST_DIR, "memory", `${today}.md`), "Had meeting with Rajesh.");
    const prompt = buildSystemPrompt(memory);
    assert.ok(prompt.includes("Had meeting with Rajesh."));
    assert.ok(prompt.includes("Today's Log"));
  });
});
