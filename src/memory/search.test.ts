import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { searchMemory, indexFile } from "./search.js";

describe("searchMemory", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text, content=chunks, content_rowid=id
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty array for no matches", () => {
    const results = searchMemory(db, "nonexistent");
    assert.equal(results.length, 0);
  });

  it("returns empty array for empty query", () => {
    const results = searchMemory(db, "");
    assert.equal(results.length, 0);
  });

  it("finds indexed content", () => {
    indexFile(db, "test.md", "Apollo Hospitals is a healthcare company in India");
    const results = searchMemory(db, "Apollo");
    assert.equal(results.length, 1);
    assert.equal(results[0]!.path, "test.md");
  });

  it("respects maxResults", () => {
    indexFile(db, "a.md", "Apollo one");
    indexFile(db, "b.md", "Apollo two");
    indexFile(db, "c.md", "Apollo three");
    const results = searchMemory(db, "Apollo", 2);
    assert.equal(results.length, 2);
  });

  it("skips re-indexing unchanged files", () => {
    const content = "Same content here";
    indexFile(db, "test.md", content);
    indexFile(db, "test.md", content);
    const count = db.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number };
    assert.equal(count.n, 1);
  });

  it("re-indexes changed files", () => {
    indexFile(db, "test.md", "Version one");
    indexFile(db, "test.md", "Version two updated");
    const results = searchMemory(db, "updated");
    assert.equal(results.length, 1);
  });
});
