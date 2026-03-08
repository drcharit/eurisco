/**
 * People Knowledge Base — Extraction Pipeline
 *
 * Builds a meticulous, verified database of people from email history.
 *
 * Pipeline:
 *   1. Header scan → identify bidirectional external contacts
 *   2. Thread reading → fetch actual email content per person
 *   3. LLM extraction → analyze threads for rich structured data
 *   4. Web verification → confirm identity, find LinkedIn, background
 *   5. Profile generation → Obsidian markdown with wikilinks
 */

import { google } from "googleapis";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type Database from "better-sqlite3";
import type { GoogleAccount } from "../services/google-auth.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface EmailHeader {
  messageId: string;
  threadId: string;
  from: string;
  fromEmail: string;
  to: string[];
  toEmails: string[];
  cc: string[];
  date: string;
  subject: string;
  account: string;
}

export interface Candidate {
  name: string;
  email: string;
  firstDate: string;
  lastDate: string;
  sentTo: number;       // emails I sent to them
  receivedFrom: number; // emails I received from them
  totalEmails: number;
  subjects: string[];
  threadIds: Set<string>;
  coEmails: Set<string>; // other external emails that appear in same threads
}

export interface PersonProfile {
  name: string;
  email: string;
  org: string;
  role: string;
  location: string;
  linkedinUrl: string;
  about: string;           // narrative paragraph from web + LLM
  howWeConnected: string;   // narrative of first interaction
  topics: string[];
  personalDetails: string[];
  timeline: { date: string; summary: string }[];
  connectedWith: string[];  // names of connected people
  firstContact: string;
  lastContact: string;
  verified: boolean;
}

// ────────────────────────────────────────────────────────────
// Step 1: Header Scan → Bidirectional External Contacts
// ────────────────────────────────────────────────────────────

export async function scanAndFilter(
  accounts: GoogleAccount[],
  ownerEmails: string[],
  afterDate: string,
  maxPerAccount: number = 5000
): Promise<Map<string, Candidate>> {
  const ownerSet = new Set(ownerEmails.map((e) => e.toLowerCase()));
  const allHeaders: EmailHeader[] = [];

  for (const account of accounts) {
    const headers = await scanHeaders(account, afterDate, maxPerAccount);
    allHeaders.push(...headers);
  }

  console.log(`[scan] Total headers: ${allHeaders.length}`);

  // Build candidate map
  const candidates = new Map<string, Candidate>();

  // Track thread participants for co-occurrence
  const threadParticipants = new Map<string, Set<string>>();

  for (const h of allHeaders) {
    // Track all external participants per thread
    if (!threadParticipants.has(h.threadId)) {
      threadParticipants.set(h.threadId, new Set());
    }
    const threadSet = threadParticipants.get(h.threadId)!;

    const fromEmail = h.fromEmail.toLowerCase();
    const isFromOwner = ownerSet.has(fromEmail);

    // All people in this email (sender + recipients)
    const allPeople = extractPeopleFromHeader(h);

    for (const person of allPeople) {
      const email = person.email.toLowerCase();

      // Skip owner
      if (ownerSet.has(email)) continue;
      // Skip internal domain (same as owner's email domain)
      const ownerDomain = Array.from(ownerSet)[0]?.split("@")[1];
      if (ownerDomain && email.endsWith(`@${ownerDomain}`)) continue;
      // Skip noise
      if (isNoiseEmail(email)) continue;

      threadSet.add(email);

      const existing = candidates.get(email);
      if (existing) {
        if (h.date < existing.firstDate) existing.firstDate = h.date;
        if (h.date > existing.lastDate) existing.lastDate = h.date;
        existing.totalEmails++;
        if (isFromOwner) existing.sentTo++;
        if (email === fromEmail) existing.receivedFrom++;
        // Keep the longer/better name
        if (person.name.length > existing.name.length && !person.name.includes("@")) {
          existing.name = person.name;
        }
        if (existing.subjects.length < 30 && !existing.subjects.includes(h.subject)) {
          existing.subjects.push(h.subject);
        }
        existing.threadIds.add(h.threadId);
      } else {
        candidates.set(email, {
          name: person.name,
          email,
          firstDate: h.date,
          lastDate: h.date,
          sentTo: isFromOwner ? 1 : 0,
          receivedFrom: email === fromEmail ? 1 : 0,
          totalEmails: 1,
          subjects: [h.subject],
          threadIds: new Set([h.threadId]),
          coEmails: new Set(),
        });
      }
    }
  }

  // Build co-occurrence
  for (const members of threadParticipants.values()) {
    const arr = Array.from(members);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        candidates.get(arr[i]!)?.coEmails.add(arr[j]!);
        candidates.get(arr[j]!)?.coEmails.add(arr[i]!);
      }
    }
  }

  // Filter: bidirectional only (I sent AND received)
  const filtered = new Map<string, Candidate>();
  for (const [email, c] of candidates) {
    if (c.sentTo > 0 && c.receivedFrom > 0) {
      filtered.set(email, c);
    }
  }

  console.log(`[scan] Unique contacts: ${candidates.size}`);
  console.log(`[scan] Bidirectional external (after filtering): ${filtered.size}`);

  return filtered;
}

async function scanHeaders(
  account: GoogleAccount,
  afterDate: string,
  maxEmails: number
): Promise<EmailHeader[]> {
  const gmail = google.gmail({ version: "v1", auth: account.auth });
  const headers: EmailHeader[] = [];
  let pageToken: string | undefined;
  let fetched = 0;

  console.log(`[scan] ${account.email}: scanning after ${afterDate} (max ${maxEmails})...`);

  const MAX_PAGES = 200;
  for (let page = 0; page < MAX_PAGES && fetched < maxEmails; page++) {
    let res;
    try {
      res = await gmail.users.messages.list({
        userId: "me",
        q: `after:${afterDate}`,
        maxResults: Math.min(100, maxEmails - fetched),
        pageToken,
      });
    } catch (e) {
      const err = e as Error;
      console.log(`[scan] ${account.email}: list error on page ${page}: ${err.message.slice(0, 100)}`);
      break;
    }

    const messages = res.data.messages ?? [];
    if (messages.length === 0) break;

    // Fetch in batches of 25
    const BATCH = 25;
    for (let i = 0; i < messages.length && fetched < maxEmails; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((m) =>
          gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata" })
        )
      );

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const h = parseHeader(r.value.data as unknown as Record<string, unknown>, account.email);
        if (h) {
          headers.push(h);
          fetched++;
        }
      }
    }

    if (fetched % 500 === 0) {
      console.log(`[scan] ${account.email}: ${fetched} headers...`);
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  console.log(`[scan] ${account.email}: ${headers.length} total`);
  return headers;
}

// ────────────────────────────────────────────────────────────
// Step 2: Thread Reading — fetch email content per person
// ────────────────────────────────────────────────────────────

export async function fetchPersonEmails(
  accounts: GoogleAccount[],
  candidate: Candidate,
  maxEmails: number = 10
): Promise<string[]> {
  const emailBodies: string[] = [];

  for (const account of accounts) {
    const gmail = google.gmail({ version: "v1", auth: account.auth });

    try {
      // Search for emails involving this person
      const res = await gmail.users.messages.list({
        userId: "me",
        q: `from:${candidate.email} OR to:${candidate.email}`,
        maxResults: maxEmails,
      });

      const messages = res.data.messages ?? [];

      for (const msg of messages.slice(0, maxEmails - emailBodies.length)) {
        if (!msg.id) continue;
        try {
          const full = await gmail.users.messages.get({
            userId: "me", id: msg.id, format: "full",
          });

          const hdrs = (full.data as unknown as Record<string, unknown>)["payload"] as
            { headers?: { name: string; value: string }[] } | undefined;
          const hdrList = hdrs?.headers ?? [];
          const getH = (n: string): string =>
            hdrList.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";

          const body = extractBodyText(full.data);
          if (body.length < 20) continue;

          const truncBody = body.length > 2000 ? body.slice(0, 2000) : body;
          emailBodies.push(
            `From: ${getH("From")}\nTo: ${getH("To")}\nDate: ${getH("Date")}\nSubject: ${getH("Subject")}\n\n${truncBody}`
          );
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return emailBodies;
}

// ────────────────────────────────────────────────────────────
// Step 3: LLM Extraction — analyze threads for rich data
// ────────────────────────────────────────────────────────────

export async function analyzeWithLLM(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  candidate: Candidate,
  emailBodies: string[]
): Promise<Partial<PersonProfile> | null> {
  const emailsText = emailBodies.slice(0, 8).join("\n\n---EMAIL BREAK---\n\n");

  const prompt = `You are building a personal CRM. Analyze these emails between the owner and ${candidate.name} (${candidate.email}).

EMAILS:
${emailsText}

Extract the following as JSON (no markdown fences, no explanation):
{
  "name": "Their proper full name (clean, no quotes, no email artifacts)",
  "org": "Their current organization (from signature, domain, or context)",
  "role": "Their job title (from signature or context)",
  "howWeConnected": "One paragraph describing how the owner and this person first connected — what was the context, who introduced them, what brought them together. Write in third person.",
  "topics": ["specific topics/projects they discussed — be concrete, not generic"],
  "personalDetails": ["any personal information: family, hobbies, location, travel, health, preferences, birthdays"],
  "timeline": [{"date": "YYYY-MM-DD", "summary": "what happened"}],
  "isPerson": true/false
}

Rules:
- "isPerson" should be false if this is a company, service, mailing list, or automated sender
- For "name", extract the real human name — clean up any email artifacts, quotes, brackets
- For "howWeConnected", write a natural paragraph. If unclear, say "Connected via email" with whatever context exists
- For "topics", be specific: project names, deal names, technologies, not generic words like "meeting" or "discussion"
- For "personalDetails", only include genuinely personal info mentioned in the emails
- For "timeline", include the most significant interactions (max 10), not every email
- If no useful data can be extracted, set isPerson to false`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(jsonStr) as Partial<PersonProfile> & { isPerson?: boolean };
  } catch (e) {
    const err = e as Error;
    console.log(`[llm] Failed for ${candidate.email}: ${err.message.slice(0, 100)}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Step 4: Web Verification — search for person online
// ────────────────────────────────────────────────────────────

export async function webVerify(
  name: string,
  email: string,
  org: string
): Promise<{ verified: boolean; linkedinUrl: string; about: string; location: string }> {
  const result = { verified: false, linkedinUrl: "", about: "", location: "" };

  // Search 1: name + email domain for identity
  const domain = email.split("@")[1] ?? "";
  const searchQuery = `"${name}" ${domain !== "gmail.com" && domain !== "yahoo.com" && domain !== "hotmail.com" ? domain : org || ""}`.trim();

  const searchResult = await safeWebSearch(searchQuery);

  // Search 2: LinkedIn specifically
  const linkedinQuery = `"${name}" ${org || ""} site:linkedin.com`;
  const linkedinResult = await safeWebSearch(linkedinQuery);

  // Extract LinkedIn URL
  const linkedinMatch = linkedinResult.match(/https?:\/\/[a-z]+\.linkedin\.com\/in\/[^\s)"\]]+/i);
  if (linkedinMatch) {
    result.linkedinUrl = linkedinMatch[0];
    result.verified = true;
  }

  // Check if search results confirm this is a real person
  const combined = searchResult + " " + linkedinResult;
  if (combined.length > 100) {
    // Look for signals that this is a real person
    const personSignals = [
      /linkedin\.com\/in\//i,
      /\b(CEO|CTO|COO|CFO|VP|Director|Manager|Engineer|Doctor|Professor|Founder|Partner|Head of)\b/i,
      /\b(University|MBA|PhD|MD|MS|BS|BA)\b/i,
      /\b(works at|working at|employed|experience)\b/i,
    ];

    for (const signal of personSignals) {
      if (signal.test(combined)) {
        result.verified = true;
        break;
      }
    }
  }

  // Try to extract location from search results
  const locationPatterns = [
    /(?:based in|located in|lives in|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?)/,
    /([A-Z][a-z]+(?:,\s*[A-Z][a-z]+)*)\s*(?:Area|Metropolitan|Region)/,
  ];

  for (const pattern of locationPatterns) {
    const match = combined.match(pattern);
    if (match) {
      result.location = match[1] ?? "";
      break;
    }
  }

  // Build about text from search snippets
  if (combined.length > 50) {
    result.about = combined.slice(0, 1500);
  }

  return result;
}

async function safeWebSearch(query: string): Promise<string> {
  try {
    const params = new URLSearchParams({ q: query, num: "5", hl: "en" });
    const res = await fetch(`https://www.google.com/search?${params}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return "";

    const html = await res.text();
    // Strip to text
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────
// Step 5: Build Narrative with LLM
// ────────────────────────────────────────────────────────────

export async function buildAboutSection(
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  profile: PersonProfile,
  webSnippets: string
): Promise<string> {
  const prompt = `Write a concise 2-3 sentence "About" paragraph for a personal CRM entry. This should read like a useful briefing — who this person is, what they do, any notable background.

Person: ${profile.name}
Org: ${profile.org || "unknown"}
Role: ${profile.role || "unknown"}
Email: ${profile.email}
Location: ${profile.location || "unknown"}
LinkedIn: ${profile.linkedinUrl || "not found"}

Web search snippets about this person:
${webSnippets.slice(0, 2000)}

Topics discussed with them: ${profile.topics.join(", ") || "unknown"}

Rules:
- Write in third person, present tense
- Be factual — only include what's supported by the data
- If you can identify education or career history from the snippets, include it
- If very little is known, write a shorter paragraph
- Do NOT make up information
- Return ONLY the paragraph text, no labels or formatting`;

  try {
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch {
    return `${profile.name}${profile.role ? `, ${profile.role}` : ""}${profile.org ? ` at ${profile.org}` : ""}.`;
  }
}

// ────────────────────────────────────────────────────────────
// Step 6: Profile Generation — Obsidian Markdown
// ────────────────────────────────────────────────────────────

const OBSIDIAN_PEOPLE = process.env["OBSIDIAN_PEOPLE_DIR"] ?? "./workspace/people/profiles";
const OBSIDIAN_UNVERIFIED = process.env["OBSIDIAN_PEOPLE_DIR"] ? `${process.env["OBSIDIAN_PEOPLE_DIR"]}-unverified` : "./workspace/people/profiles-unverified";

export function writeObsidianProfile(
  profile: PersonProfile
): void {
  const dir = profile.verified ? OBSIDIAN_PEOPLE : OBSIDIAN_UNVERIFIED;
  mkdirSync(dir, { recursive: true });

  const safeName = profile.name.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  if (!safeName || safeName.length < 2) return;

  const filePath = resolve(dir, `${safeName}.md`);

  // Determine relationship status
  const daysSinceContact = daysBetween(profile.lastContact, todayStr());
  const status = daysSinceContact < 30 ? "active" : daysSinceContact < 90 ? "cooling" : "cold";

  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`name: "${esc(profile.name)}"`);
  if (profile.org) lines.push(`org: "${esc(profile.org)}"`);
  if (profile.role) lines.push(`role: "${esc(profile.role)}"`);
  if (profile.location) lines.push(`location: "${esc(profile.location)}"`);
  lines.push(`email: "${profile.email}"`);
  if (profile.linkedinUrl) lines.push(`linkedin: "${profile.linkedinUrl}"`);
  lines.push(`first_contact: ${profile.firstContact}`);
  lines.push(`last_contact: ${profile.lastContact}`);
  lines.push(`status: ${status}`);

  const tags = ["person"];
  if (profile.org) tags.push(`org/${slugifyTag(profile.org)}`);
  lines.push(`tags: [${tags.join(", ")}]`);
  lines.push("---");
  lines.push("");

  // About
  if (profile.about) {
    lines.push("## About");
    lines.push(profile.about);
    lines.push("");
  }

  // How We Connected
  if (profile.howWeConnected) {
    lines.push("## How We Connected");
    lines.push(profile.howWeConnected);
    lines.push("");
  }

  // Topics
  if (profile.topics.length > 0) {
    lines.push("## Topics We Discussed");
    for (const t of profile.topics) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  // Personal
  if (profile.personalDetails.length > 0) {
    lines.push("## Personal");
    for (const d of profile.personalDetails) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // Connected With
  if (profile.connectedWith.length > 0) {
    lines.push("## Connected With");
    for (const c of profile.connectedWith) {
      const cSafe = c.replace(/[/\\:*?"<>|]/g, "-").trim();
      lines.push(`- [[${cSafe}]]`);
    }
    lines.push("");
  }

  // Timeline
  if (profile.timeline.length > 0) {
    lines.push("## Timeline");
    lines.push("| Date | Summary |");
    lines.push("|------|---------|");
    for (const t of profile.timeline) {
      lines.push(`| ${t.date} | ${t.summary.replace(/\|/g, "—")} |`);
    }
    lines.push("");
  }

  writeFileSync(filePath, lines.join("\n"));
}

// ────────────────────────────────────────────────────────────
// Full Pipeline — process one person at a time
// ────────────────────────────────────────────────────────────

export async function processPerson(
  accounts: GoogleAccount[],
  candidate: Candidate,
  allCandidates: Map<string, Candidate>,
  model: ReturnType<GoogleGenerativeAI["getGenerativeModel"]>,
  db: Database.Database
): Promise<PersonProfile | null> {
  const t0 = performance.now();
  console.log(`\n[person] Processing: ${candidate.name} <${candidate.email}> (${candidate.totalEmails} emails)`);

  // Step 2: Fetch their email threads
  const emailBodies = await fetchPersonEmails(accounts, candidate, 10);
  if (emailBodies.length === 0) {
    console.log(`[person] No email bodies found, skipping`);
    return null;
  }
  console.log(`[person] Fetched ${emailBodies.length} emails`);

  // Step 3: LLM extraction
  const extracted = await analyzeWithLLM(model, candidate, emailBodies);
  if (!extracted) {
    console.log(`[person] LLM extraction failed, skipping`);
    return null;
  }

  // Check if it's actually a person
  const isPerson = (extracted as Record<string, unknown>)["isPerson"];
  if (isPerson === false) {
    console.log(`[person] Not a person (company/service), skipping`);
    return null;
  }

  const cleanName = cleanPersonName(extracted.name ?? candidate.name);
  if (!cleanName || cleanName.length < 2) return null;

  // Step 4: Web verification
  console.log(`[person] Web verifying: ${cleanName}`);
  await sleep(1500); // Rate limit web searches
  const webResult = await webVerify(cleanName, candidate.email, extracted.org ?? "");

  // Step 5: Build profile
  const profile: PersonProfile = {
    name: cleanName,
    email: candidate.email,
    org: extracted.org ?? "",
    role: extracted.role ?? "",
    location: webResult.location || "",
    linkedinUrl: webResult.linkedinUrl || "",
    about: "",
    howWeConnected: (extracted as Record<string, unknown>)["howWeConnected"] as string ?? "",
    topics: extracted.topics ?? [],
    personalDetails: extracted.personalDetails ?? [],
    timeline: extracted.timeline ?? [],
    connectedWith: buildConnections(candidate, allCandidates),
    firstContact: candidate.firstDate,
    lastContact: candidate.lastDate,
    verified: webResult.verified,
  };

  // Build narrative "About" section
  if (webResult.about) {
    profile.about = await buildAboutSection(model, profile, webResult.about);
  } else {
    profile.about = `${profile.name}${profile.role ? `, ${profile.role}` : ""}${profile.org ? ` at ${profile.org}` : ""}.`;
  }

  // Write to Obsidian
  writeObsidianProfile(profile);

  // Save to DB
  saveToDb(db, profile);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`[person] Done: ${cleanName} [${profile.verified ? "verified" : "unverified"}] (${elapsed}s)`);

  return profile;
}

function buildConnections(
  candidate: Candidate,
  allCandidates: Map<string, Candidate>
): string[] {
  const connections: string[] = [];
  for (const coEmail of candidate.coEmails) {
    const co = allCandidates.get(coEmail);
    if (!co) continue;
    // Only link to people who are also bidirectional contacts
    if (co.sentTo > 0 && co.receivedFrom > 0) {
      const name = cleanPersonName(co.name);
      if (name && !connections.includes(name)) {
        connections.push(name);
      }
    }
    if (connections.length >= 10) break;
  }
  return connections;
}

function saveToDb(db: Database.Database, profile: PersonProfile): void {
  const slug = slugify(profile.name);
  if (!slug) return;

  const existing = db.prepare("SELECT id FROM people WHERE slug = ?").get(slug) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE people SET name=?, email=?, org=?, role=?, first_contact_date=?,
        first_contact_source='email', linkedin_url=?, personal_notes=?, updated_at=unixepoch()
      WHERE id=?
    `).run(profile.name, profile.email, profile.org, profile.role,
      profile.firstContact, profile.linkedinUrl,
      profile.personalDetails.join("\n"), existing.id);
  } else {
    const result = db.prepare(`
      INSERT INTO people (name, email, org, role, slug, first_contact_date, first_contact_source, linkedin_url, personal_notes)
      VALUES (?, ?, ?, ?, ?, ?, 'email', ?, ?)
    `).run(profile.name, profile.email, profile.org, profile.role, slug,
      profile.firstContact, profile.linkedinUrl, profile.personalDetails.join("\n"));

    const personId = result.lastInsertRowid as number;
    db.prepare("INSERT OR IGNORE INTO people_fts (rowid, name, org, role) VALUES (?, ?, ?, ?)")
      .run(personId, profile.name, profile.org, profile.role);
    db.prepare("INSERT OR IGNORE INTO people_emails (person_id, email, source) VALUES (?, ?, 'email')")
      .run(personId, profile.email);
  }

  // Save topics
  const person = db.prepare("SELECT id FROM people WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (person) {
    for (const topic of profile.topics.slice(0, 10)) {
      db.prepare("INSERT OR IGNORE INTO topics (person_id, topic, first_mentioned, last_mentioned) VALUES (?, ?, ?, ?)")
        .run(person.id, topic, profile.firstContact, profile.lastContact);
    }
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function parseHeader(data: Record<string, unknown>, accountEmail: string): EmailHeader | null {
  const payload = data["payload"] as { headers?: { name: string; value: string }[] } | undefined;
  const hdrs = payload?.headers ?? [];
  const get = (name: string): string =>
    hdrs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const from = get("From");
  const to = get("To");
  const cc = get("Cc");
  const date = get("Date");
  const subject = get("Subject");
  const messageId = data["id"] as string;
  const threadId = data["threadId"] as string;

  if (!from || !messageId) return null;

  const fromParsed = parseEmailAddress(from);

  return {
    messageId, threadId,
    from, fromEmail: fromParsed.email,
    to: splitAddresses(to), toEmails: splitAddresses(to).map((a) => parseEmailAddress(a).email),
    cc: splitAddresses(cc),
    date: safeDate(date), subject,
    account: accountEmail,
  };
}

function extractPeopleFromHeader(h: EmailHeader): { name: string; email: string }[] {
  const people: { name: string; email: string }[] = [];
  const all = [h.from, ...h.to, ...h.cc];
  for (const raw of all) {
    const parsed = parseEmailAddress(raw);
    if (parsed.email) people.push(parsed);
  }
  return people;
}

function parseEmailAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^"?([^"<]+)"?\s*<([^>]+)>/);
  if (match) {
    return { name: match[1]!.trim(), email: match[2]!.toLowerCase().trim() };
  }
  const email = raw.trim().toLowerCase();
  const name = email.split("@")[0]?.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) ?? email;
  return { name, email };
}

function splitAddresses(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isNoiseEmail(email: string): boolean {
  const lower = email.toLowerCase();
  const noisePatterns = [
    "noreply", "no-reply", "notifications", "mailer-daemon",
    "postmaster", "calendar-notification", "donotreply", "do-not-reply",
    "updates@", "support@", "info@", "news@", "newsletter",
    "billing@", "invoice@", "receipts@", "alerts@",
    "feedback@", "hello@", "team@", "admin@", "help@",
    "sales@", "contact@", "service@", "enquiry@", "inquiry@",
    "marketing@", "press@", "media@", "pr@", "careers@",
    "hr@", "jobs@", "recruit@", "hiring@",
    "googlegroups.com", "github.com", "linkedin.com",
    "facebookmail.com", "amazonses.com", "mailchimp.com",
    "sendgrid.net", "mandrillapp.com", "intercom.io",
    "zendesk.com", "freshdesk.com", "helpscout.net",
    "slack.com", "atlassian.com", "jira@", "confluence@",
    "calendar-server", "bounce", "daemon",
    "cron@", "root@", "www-data@", "nobody@",
  ];
  return noisePatterns.some((p) => lower.includes(p));
}

function cleanPersonName(raw: string): string {
  return raw
    .replace(/^['"\-<\s]+/, "")       // leading junk
    .replace(/['"\->]+$/, "")         // trailing junk
    .replace(/<[^>]+>/g, "")          // email in angle brackets
    .replace(/\([^)]*\)/g, "")        // parenthetical
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim();
}

function safeDate(dateStr: string): string {
  try {
    return new Date(dateStr).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / msPerDay;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function slugifyTag(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function esc(s: string): string {
  return s.replace(/"/g, '\\"');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBodyText(data: any): string {
  const payload = data.payload;
  if (!payload) return "";

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
      for (const sub of parts) {
        stack.push({ part: sub, depth: depth + 1 });
      }
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
