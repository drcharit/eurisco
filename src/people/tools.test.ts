import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { peopleSearch, peopleUpsert, peopleLog } from "./tools.js";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dirname, "..", "..", "test-tmp-people");
const PROFILES_DIR = resolve(TEST_DIR, "profiles");

describe("people tools", () => {
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(PROFILES_DIR, { recursive: true });
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        org TEXT,
        role TEXT,
        slug TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE VIRTUAL TABLE people_fts USING fts5(name, org, role);

      CREATE TABLE interactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL REFERENCES people(id),
        date TEXT NOT NULL,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        raw_ref TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE VIRTUAL TABLE interactions_fts USING fts5(summary);
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("peopleUpsert", () => {
    it("creates a new person", () => {
      const result = peopleUpsert(db, PROFILES_DIR, {
        name: "Rajesh Kumar",
        org: "Apollo Hospitals",
        role: "Cardiologist",
        email: "rajesh@apollo.com",
      });
      assert.ok(result.includes("Created"));
      assert.ok(existsSync(resolve(PROFILES_DIR, "rajesh-kumar.md")));
    });

    it("creates profile with correct content", () => {
      peopleUpsert(db, PROFILES_DIR, {
        name: "Rajesh Kumar",
        org: "Apollo",
        email: "r@a.com",
      });
      const content = readFileSync(resolve(PROFILES_DIR, "rajesh-kumar.md"), "utf-8");
      assert.ok(content.includes("# Rajesh Kumar"));
      assert.ok(content.includes("Apollo"));
      assert.ok(content.includes("r@a.com"));
    });

    it("updates existing person", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar", org: "Apollo" });
      const result = peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar", role: "CTO" });
      assert.ok(result.includes("Updated"));

      const row = db.prepare("SELECT role FROM people WHERE slug = ?").get("rajesh-kumar") as { role: string };
      assert.equal(row.role, "CTO");
    });
  });

  describe("peopleSearch", () => {
    it("returns no results for empty db", () => {
      const result = peopleSearch(db, "nobody");
      assert.equal(result, "No results.");
    });

    it("finds person by name", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar", org: "Apollo" });
      const result = peopleSearch(db, "Rajesh");
      assert.ok(result.includes("Rajesh Kumar"));
      assert.ok(result.includes("Apollo"));
    });

    it("finds person by org", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar", org: "Apollo" });
      const result = peopleSearch(db, "Apollo");
      assert.ok(result.includes("Rajesh Kumar"));
    });
  });

  describe("peopleLog", () => {
    it("logs interaction for existing person", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar" });
      const result = peopleLog(db, PROFILES_DIR, {
        name: "Rajesh Kumar",
        source: "email",
        summary: "Discussed pilot program timeline",
      });
      assert.ok(result.includes("Logged"));
      assert.ok(result.includes("email"));
    });

    it("auto-creates person if not found", () => {
      const result = peopleLog(db, PROFILES_DIR, {
        name: "New Person",
        source: "meeting",
        summary: "Met at conference",
      });
      assert.ok(result.includes("Logged"));
      assert.ok(existsSync(resolve(PROFILES_DIR, "new-person.md")));
    });

    it("appends to profile markdown", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar" });
      peopleLog(db, PROFILES_DIR, {
        name: "Rajesh Kumar",
        source: "email",
        summary: "Sent proposal",
        date: "2026-03-07",
      });
      const content = readFileSync(resolve(PROFILES_DIR, "rajesh-kumar.md"), "utf-8");
      assert.ok(content.includes("2026-03-07"));
      assert.ok(content.includes("Sent proposal"));
    });

    it("interaction is searchable", () => {
      peopleUpsert(db, PROFILES_DIR, { name: "Rajesh Kumar" });
      peopleLog(db, PROFILES_DIR, {
        name: "Rajesh Kumar",
        source: "meeting",
        summary: "Discussed AI-ECG screening project",
      });
      const result = peopleSearch(db, "AI ECG screening");
      assert.ok(result.includes("AI-ECG"));
    });
  });
});
