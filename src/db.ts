import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

function migrateSchema(db: Database.Database): void {
  // Add new columns to people table if they don't exist
  const cols = db.prepare("PRAGMA table_info(people)").all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  const newCols: [string, string][] = [
    ["first_contact_date", "TEXT"],
    ["first_contact_source", "TEXT"],
    ["introduced_by_id", "INTEGER REFERENCES people(id)"],
    ["linkedin_url", "TEXT"],
    ["next_followup", "TEXT"],
    ["personal_notes", "TEXT"],
  ];

  for (const [name, type] of newCols) {
    if (!colNames.has(name)) {
      db.exec(`ALTER TABLE people ADD COLUMN ${name} ${type}`);
    }
  }
}

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = resolve(dataDir, "kit.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  // Migrate existing people table with new columns
  migrateSchema(db);

  db.exec(`
    -- Conversation history
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- Memory chunks for FTS5
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, content=chunks, content_rowid=id
    );

    -- People
    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      org TEXT,
      role TEXT,
      slug TEXT UNIQUE NOT NULL,
      first_contact_date TEXT,
      first_contact_source TEXT,
      introduced_by_id INTEGER REFERENCES people(id),
      linkedin_url TEXT,
      next_followup TEXT,
      personal_notes TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
      name, org, role
    );

    -- A person can have multiple email addresses
    CREATE TABLE IF NOT EXISTS people_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id),
      email TEXT NOT NULL UNIQUE,
      source TEXT
    );

    -- Interactions
    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id),
      date TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      raw_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts USING fts5(
      summary
    );

    -- Topics discussed with a person
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id),
      topic TEXT NOT NULL,
      first_mentioned TEXT,
      last_mentioned TEXT,
      UNIQUE(person_id, topic)
    );

    -- Connections between people (introductions, co-occurrence)
    CREATE TABLE IF NOT EXISTS connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_a_id INTEGER NOT NULL REFERENCES people(id),
      person_b_id INTEGER NOT NULL REFERENCES people(id),
      relationship TEXT,
      context TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(person_a_id, person_b_id, relationship)
    );

    -- Track which emails have been processed (for incremental runs)
    CREATE TABLE IF NOT EXISTS processed_emails (
      message_id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      processed_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
