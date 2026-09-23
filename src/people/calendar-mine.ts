/**
 * Calendar Mining Pipeline
 *
 * Scans Google Calendar for both accounts going back 10 years,
 * matches attendees to known people, and adds meetings as interactions.
 *
 * Usage:
 *   npx tsx src/people/calendar-mine.ts
 */

import { resolve } from "node:path";
import { google } from "googleapis";
import type { GoogleAccount } from "../services/google-auth.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { createGoogleAccounts } from "../services/google-auth.js";
const ROOT_DIR = resolve(import.meta.dirname, "../..");

interface CalendarMeeting {
  eventId: string;
  summary: string;
  date: string;
  attendeeEmails: string[];
  attendeeNames: Map<string, string>; // email → displayName
  location: string;
  account: string;
}

async function main(): Promise<void> {
  const t0 = performance.now();
  const config = loadConfig(ROOT_DIR);
  const db = openDatabase(config.dataDir);
  const accounts = createGoogleAccounts(config);
  const ownerEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

  if (accounts.length === 0) {
    console.error("No Google accounts configured.");
    process.exit(1);
  }

  console.log(`Accounts: ${accounts.map((a) => a.email).join(", ")}`);

  // Fetch events from all accounts
  const allMeetings: CalendarMeeting[] = [];
  for (const account of accounts) {
    const meetings = await fetchCalendarEvents(account, ownerEmails);
    allMeetings.push(...meetings);
    console.log(`[calendar] ${account.email}: ${meetings.length} meetings with external attendees`);
  }

  console.log(`\nTotal meetings with external attendees: ${allMeetings.length}`);

  // Build email → person_id lookup
  const emailToPersonId = new Map<string, number>();
  const allEmails = db.prepare("SELECT person_id, email FROM people_emails").all() as { person_id: number; email: string }[];
  for (const row of allEmails) {
    emailToPersonId.set(row.email.toLowerCase(), row.person_id);
  }
  // Also check primary email in people table
  const allPeople = db.prepare("SELECT id, email FROM people WHERE email IS NOT NULL").all() as { id: number; email: string }[];
  for (const row of allPeople) {
    if (row.email && !emailToPersonId.has(row.email.toLowerCase())) {
      emailToPersonId.set(row.email.toLowerCase(), row.id);
    }
  }

  console.log(`Known email addresses in DB: ${emailToPersonId.size}`);

  // Process meetings
  let matched = 0;
  let interactions = 0;
  let firstContactUpdated = 0;
  const unmatchedEmails = new Map<string, { name: string; count: number }>();

  const insertInteraction = db.prepare(`
    INSERT OR IGNORE INTO interactions (person_id, date, source, summary, raw_ref)
    VALUES (?, ?, 'calendar', ?, ?)
  `);

  const updateFirstContact = db.prepare(`
    UPDATE people SET first_contact_date = ?, first_contact_source = 'calendar'
    WHERE id = ? AND (first_contact_date IS NULL OR first_contact_date > ?)
  `);

  const checkProcessed = db.prepare(`
    SELECT 1 FROM processed_calendar_events WHERE event_id = ? AND account = ?
  `);

  const markProcessed = db.prepare(`
    INSERT OR IGNORE INTO processed_calendar_events (event_id, account) VALUES (?, ?)
  `);

  const processAll = db.transaction(() => {
    for (const meeting of allMeetings) {
      // Skip already processed
      if (checkProcessed.get(meeting.eventId, meeting.account)) continue;

      let meetingMatched = false;

      for (const email of meeting.attendeeEmails) {
        const personId = emailToPersonId.get(email.toLowerCase());
        if (personId) {
          meetingMatched = true;
          const result = insertInteraction.run(
            personId, meeting.date, meeting.summary, meeting.eventId
          );
          if (result.changes > 0) interactions++;

          // Update first contact if this meeting predates known first contact
          const updated = updateFirstContact.run(meeting.date, personId, meeting.date);
          if (updated.changes > 0) firstContactUpdated++;
        } else {
          const name = meeting.attendeeNames.get(email) ?? email;
          const existing = unmatchedEmails.get(email);
          if (existing) {
            existing.count++;
          } else {
            unmatchedEmails.set(email, { name, count: 1 });
          }
        }
      }

      if (meetingMatched) matched++;
      markProcessed.run(meeting.eventId, meeting.account);
    }
  });

  processAll();

  // Report
  console.log("\n=== Calendar Mining Complete ===");
  console.log(`Meetings processed:     ${allMeetings.length}`);
  console.log(`Matched to known people: ${matched}`);
  console.log(`Interactions added:      ${interactions}`);
  console.log(`First contact updated:   ${firstContactUpdated}`);

  // Show top unmatched
  const sortedUnmatched = Array.from(unmatchedEmails.entries())
    .sort((a, b) => b[1].count - a[1].count);

  if (sortedUnmatched.length > 0) {
    console.log(`\nUnmatched attendees: ${sortedUnmatched.length}`);
    console.log("Top 20:");
    for (const [email, { name, count }] of sortedUnmatched.slice(0, 20)) {
      console.log(`  ${name} <${email}> — ${count} meetings`);
    }
  }

  db.close();
  console.log(`\nTotal time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

async function fetchCalendarEvents(
  account: GoogleAccount,
  ownerEmails: Set<string>
): Promise<CalendarMeeting[]> {
  const calendar = google.calendar({ version: "v3", auth: account.auth });
  const meetings: CalendarMeeting[] = [];

  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);

  let pageToken: string | undefined;
  let totalEvents = 0;

  console.log(`[calendar] ${account.email}: scanning from ${tenYearsAgo.toISOString().slice(0, 10)}...`);

  for (let page = 0; page < 100; page++) {
    let res;
    try {
      res = await calendar.events.list({
        calendarId: "primary",
        timeMin: tenYearsAgo.toISOString(),
        timeMax: new Date().toISOString(),
        singleEvents: true,
        maxResults: 2500,
        pageToken,
      });
    } catch (e) {
      const err = e as Error;
      console.log(`[calendar] ${account.email}: API error: ${err.message.slice(0, 100)}`);
      break;
    }

    const events = res.data.items ?? [];
    totalEvents += events.length;

    for (const event of events) {
      if (!event.id || !event.summary) continue;

      const attendees = event.attendees ?? [];
      // Filter to external attendees only
      const externalAttendees = attendees.filter((a) => {
        if (!a.email) return false;
        const email = a.email.toLowerCase();
        if (ownerEmails.has(email)) return false;
        if (email.endsWith("@tricog.com")) return false; // internal
        if (email.includes("calendar.google.com")) return false;
        if (email.includes("resource.calendar")) return false;
        return true;
      });

      if (externalAttendees.length === 0) continue;

      const date = event.start?.dateTime?.slice(0, 10) ?? event.start?.date ?? "";
      if (!date) continue;

      const attendeeNames = new Map<string, string>();
      for (const a of externalAttendees) {
        if (a.email && a.displayName) {
          attendeeNames.set(a.email.toLowerCase(), a.displayName);
        }
      }

      meetings.push({
        eventId: event.id,
        summary: event.summary,
        date,
        attendeeEmails: externalAttendees.map((a) => a.email!.toLowerCase()),
        attendeeNames,
        location: event.location ?? "",
        account: account.email,
      });
    }

    if (totalEvents % 1000 === 0 && totalEvents > 0) {
      console.log(`[calendar] ${account.email}: ${totalEvents} events scanned, ${meetings.length} with external attendees...`);
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  console.log(`[calendar] ${account.email}: ${totalEvents} total events, ${meetings.length} with external attendees`);
  return meetings;
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
