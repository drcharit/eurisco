import type Database from "better-sqlite3";
import type { GoogleAccount } from "../services/google-auth.js";
import { findAccount } from "../services/google-auth.js";
import { gmailSearch, gmailSend } from "../services/gmail.js";
import { google } from "googleapis";

// ── Types ──

export interface PersonRow {
  id: number;
  name: string;
  email: string;
  org: string;
  role: string;
  type: string;
  slug: string;
  first_contact_date: string;
  linkedin_url: string;
  next_followup: string;
  personal_notes: string;
}

interface TopicRow { topic: string }
interface InteractionRow { date: string; source: string; summary: string }

// ── People queries ──

export function listPeople(
  db: Database.Database,
  filters: { type?: string; org?: string; search?: string }
): PersonRow[] {
  let query = `SELECT * FROM people WHERE 1=1`;
  const params: unknown[] = [];

  if (filters.type) {
    query += ` AND type = ?`;
    params.push(filters.type);
  }
  if (filters.org) {
    query += ` AND org = ?`;
    params.push(filters.org);
  }
  if (filters.search) {
    query += ` AND (name LIKE ? OR org LIKE ? OR role LIKE ? OR email LIKE ?)`;
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }

  query += ` ORDER BY name ASC`;
  return db.prepare(query).all(...params) as PersonRow[];
}

export function getPerson(db: Database.Database, slug: string): {
  person: PersonRow;
  topics: string[];
  interactions: InteractionRow[];
  emails: string[];
} | null {
  const person = db.prepare("SELECT * FROM people WHERE slug = ?").get(slug) as PersonRow | undefined;
  if (!person) return null;

  const topics = (db.prepare("SELECT topic FROM topics WHERE person_id = ? ORDER BY last_mentioned DESC")
    .all(person.id) as TopicRow[]).map((t) => t.topic);

  const interactions = db.prepare(
    "SELECT date, source, summary FROM interactions WHERE person_id = ? ORDER BY date DESC LIMIT 50"
  ).all(person.id) as InteractionRow[];

  const emailRows = db.prepare("SELECT email FROM people_emails WHERE person_id = ?")
    .all(person.id) as { email: string }[];
  const emails = emailRows.map((e) => e.email);
  if (person.email && !emails.includes(person.email)) emails.unshift(person.email);

  return { person, topics, interactions, emails };
}

export function getOverdue(db: Database.Database): PersonRow[] {
  return db.prepare(`
    SELECT * FROM people
    WHERE next_followup IS NOT NULL AND next_followup < date('now')
    ORDER BY next_followup ASC
  `).all() as PersonRow[];
}

export function getStats(db: Database.Database): Record<string, number> {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;

  const overdue = (db.prepare(`
    SELECT COUNT(*) as n FROM people WHERE next_followup IS NOT NULL AND next_followup < date('now')
  `).get() as { n: number }).n;

  return {
    people: count("people"),
    topics: count("topics"),
    interactions: count("interactions"),
    connections: count("connections"),
    overdue,
  };
}

export function getTypes(db: Database.Database): { type: string; count: number }[] {
  return db.prepare(`
    SELECT type, COUNT(*) as count FROM people
    WHERE type IS NOT NULL AND type != ''
    GROUP BY type ORDER BY count DESC
  `).all() as { type: string; count: number }[];
}

export function getOrgs(db: Database.Database): { org: string; count: number }[] {
  return db.prepare(`
    SELECT org, COUNT(*) as count FROM people
    WHERE org IS NOT NULL AND org != ''
    GROUP BY org ORDER BY count DESC LIMIT 50
  `).all() as { org: string; count: number }[];
}

// ── Gmail ──

export async function getPersonEmails(
  accounts: GoogleAccount[],
  email: string
): Promise<{ account: string; results: string }[]> {
  const results: { account: string; results: string }[] = [];
  for (const account of accounts) {
    try {
      const r = await gmailSearch(account, `from:${email} OR to:${email}`, 8);
      results.push({ account: account.email, results: r });
    } catch {
      results.push({ account: account.email, results: "Error fetching emails" });
    }
  }
  return results;
}

export async function readEmail(
  accounts: GoogleAccount[],
  accountEmail: string,
  messageId: string
): Promise<string> {
  const account = findAccount(accounts, accountEmail);
  if (!account) return "Account not found";

  const gmail = google.gmail({ version: "v1", auth: account.auth });
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });

  const headers = msg.data.payload?.headers ?? [];
  const get = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

  let body = extractBody(msg.data);
  if (body.length > 6000) body = body.slice(0, 6000) + "\n... (truncated)";

  return JSON.stringify({
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
    body,
  });
}

export async function sendEmail(
  accounts: GoogleAccount[],
  accountEmail: string,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<string> {
  const account = findAccount(accounts, accountEmail);
  if (!account) return "Account not found";
  return gmailSend(account, to, subject, body, threadId);
}

export function getAccounts(accounts: GoogleAccount[]): { email: string; name: string }[] {
  return accounts.map((a) => ({ email: a.email, name: a.name }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(data: any): string {
  const payload = data.payload;
  if (!payload) return "(no body)";

  const leaves: { mimeType: string; data: string }[] = [];
  const stack: { part: Record<string, unknown>; depth: number }[] = [{ part: payload, depth: 0 }];

  for (let i = 0; i < 50 && i < stack.length; i++) {
    const { part, depth } = stack[i]!;
    if (depth > 5) continue;
    const body = part["body"] as { data?: string } | undefined;
    if (body?.data) {
      leaves.push({ mimeType: (part["mimeType"] as string) ?? "", data: body.data });
    }
    const parts = part["parts"] as Record<string, unknown>[] | undefined;
    if (parts) {
      for (const sub of parts) stack.push({ part: sub, depth: depth + 1 });
    }
  }

  const plain = leaves.find((p) => p.mimeType === "text/plain");
  if (plain) return Buffer.from(plain.data, "base64url").toString("utf-8");
  const html = leaves.find((p) => p.mimeType === "text/html");
  if (html) {
    const decoded = Buffer.from(html.data, "base64url").toString("utf-8");
    return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  return data.snippet ?? "";
}
