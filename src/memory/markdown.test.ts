import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarkdownMemory } from "./markdown.js";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dirname, "..", "..", "test-tmp-memory");

describe("MarkdownMemory", () => {
  let mem: MarkdownMemory;

  beforeEach(() => {
    mkdirSync(resolve(TEST_DIR, "memory"), { recursive: true });
    mem = new MarkdownMemory(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty string for missing SOUL.md", () => {
    assert.equal(mem.readSoul(), "");
  });

  it("reads SOUL.md when present", () => {
    writeFileSync(resolve(TEST_DIR, "SOUL.md"), "You are Kit.");
    assert.equal(mem.readSoul(), "You are Kit.");
  });

  it("reads MEMORY.md", () => {
    writeFileSync(resolve(TEST_DIR, "MEMORY.md"), "User likes coffee.");
    assert.equal(mem.readLongTermMemory(), "User likes coffee.");
  });

  it("appends to daily log with timestamp", () => {
    const date = mem.todayDate();
    mem.appendToDaily("Test entry");
    const content = readFileSync(resolve(TEST_DIR, "memory", `${date}.md`), "utf-8");
    assert.ok(content.includes("Test entry"));
    assert.ok(content.includes("###"));
  });

  it("reads daily log by date", () => {
    const date = "2026-01-15";
    writeFileSync(resolve(TEST_DIR, "memory", `${date}.md`), "Old log.");
    assert.equal(mem.readDailyLog(date), "Old log.");
  });

  it("todayDate returns YYYY-MM-DD format", () => {
    const d = mem.todayDate();
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  });
});
