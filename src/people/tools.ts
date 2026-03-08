import type Database from "better-sqlite3";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface Person {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  org: string | null;
  role: string | null;
  slug: string;
}

export interface Interaction {
  id: number;
  person_id: number;
  date: string;
  source: string;
  summary: string;
}

export function peopleSearch(db: Database.Database, query: string): string {
  const sanitized = query.replace(/[^\w\s]/g, " ").trim();
  if (!sanitized) return "No results.";

  const people = db.prepare(`
    SELECT p.* FROM people_fts
    JOIN people p ON people_fts.rowid = p.id
    WHERE people_fts MATCH ?
    LIMIT 10
  `).all(sanitized) as Person[];

  const interactions = db.prepare(`
    SELECT i.*, p.name as person_name FROM interactions_fts
    JOIN interactions i ON interactions_fts.rowid = i.id
    JOIN people p ON i.person_id = p.id
    WHERE interactions_fts MATCH ?
    LIMIT 10
  `).all(sanitized) as (Interaction & { person_name: string })[];

  return formatSearchResults(people, interactions);
}

function formatSearchResults(
  people: Person[],
  interactions: (Interaction & { person_name: string })[]
): string {
  const parts: string[] = [];
  for (const p of people) {
    parts.push(`[Person] ${p.name} — ${p.org ?? "?"} — ${p.role ?? "?"} (${p.email ?? "no email"})`);
  }
  for (const i of interactions) {
    parts.push(`[Interaction] ${i.person_name} (${i.date}, ${i.source}): ${i.summary}`);
  }
  return parts.length > 0 ? parts.join("\n") : "No results.";
}

export function peopleUpsert(
  db: Database.Database,
  profilesDir: string,
  args: { name: string; email?: string; org?: string; role?: string; notes?: string }
): string {
  const slug = slugify(args.name);
  const existing = db.prepare("SELECT id FROM people WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;

  if (existing) {
    return updatePerson(db, profilesDir, existing.id, slug, args);
  }
  return createPerson(db, profilesDir, slug, args);
}

function createPerson(
  db: Database.Database,
  profilesDir: string,
  slug: string,
  args: { name: string; email?: string; org?: string; role?: string; notes?: string }
): string {
  const result = db.prepare(`
    INSERT INTO people (name, email, org, role, slug)
    VALUES (?, ?, ?, ?, ?)
  `).run(args.name, args.email ?? null, args.org ?? null, args.role ?? null, slug);

  db.prepare("INSERT INTO people_fts (rowid, name, org, role) VALUES (?, ?, ?, ?)").run(
    result.lastInsertRowid, args.name, args.org ?? "", args.role ?? ""
  );

  writeProfile(profilesDir, slug, args);
  return `Created profile for ${args.name} (${slug})`;
}

function updatePerson(
  db: Database.Database,
  profilesDir: string,
  id: number,
  slug: string,
  args: { name: string; email?: string; org?: string; role?: string; notes?: string }
): string {
  db.prepare(`
    UPDATE people SET
      email = COALESCE(?, email),
      org = COALESCE(?, org),
      role = COALESCE(?, role),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(args.email ?? null, args.org ?? null, args.role ?? null, id);

  writeProfile(profilesDir, slug, args);
  return `Updated profile for ${args.name} (${slug})`;
}

export function peopleLog(
  db: Database.Database,
  profilesDir: string,
  args: { name: string; source: string; summary: string; date?: string }
): string {
  const slug = slugify(args.name);
  const person = db.prepare("SELECT id FROM people WHERE slug = ?").get(slug) as
    | { id: number }
    | undefined;

  if (!person) {
    peopleUpsert(db, profilesDir, { name: args.name });
    const created = db.prepare("SELECT id FROM people WHERE slug = ?").get(slug) as
      | { id: number }
      | undefined;
    if (!created) return `Error: failed to create person ${args.name}`;
    return logInteraction(db, profilesDir, created.id, slug, args);
  }

  return logInteraction(db, profilesDir, person.id, slug, args);
}

function logInteraction(
  db: Database.Database,
  profilesDir: string,
  personId: number,
  slug: string,
  args: { name: string; source: string; summary: string; date?: string }
): string {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const result = db.prepare(`
    INSERT INTO interactions (person_id, date, source, summary)
    VALUES (?, ?, ?, ?)
  `).run(personId, date, args.source, args.summary);

  db.prepare("INSERT INTO interactions_fts (rowid, summary) VALUES (?, ?)").run(
    result.lastInsertRowid, args.summary
  );

  appendToProfile(profilesDir, slug, date, args.source, args.summary);
  return `Logged ${args.source} interaction with ${args.name} on ${date}`;
}

function writeProfile(
  profilesDir: string,
  slug: string,
  args: { name: string; email?: string; org?: string; role?: string; notes?: string }
): void {
  mkdirSync(profilesDir, { recursive: true });
  const filePath = resolve(profilesDir, `${slug}.md`);
  if (existsSync(filePath)) return;

  const lines = [`# ${args.name}`];
  if (args.org) lines.push(`- **Org**: ${args.org}`);
  if (args.role) lines.push(`- **Role**: ${args.role}`);
  if (args.email) lines.push(`- **Email**: ${args.email}`);
  if (args.notes) lines.push(`\n## Notes\n${args.notes}`);
  lines.push("\n## Interaction Log\n");

  writeFileSync(filePath, lines.join("\n"));
}

function appendToProfile(
  profilesDir: string,
  slug: string,
  date: string,
  source: string,
  summary: string
): void {
  const filePath = resolve(profilesDir, `${slug}.md`);
  if (!existsSync(filePath)) return;
  const entry = `### ${date} — ${source}\n- ${summary}\n\n`;
  const content = readFileSync(filePath, "utf-8");
  writeFileSync(filePath, content + entry);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
