import { google } from "googleapis";
import type { GoogleAccount } from "./google-auth.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  attendees: string[];
  description: string;
}

export async function calendarList(
  account: GoogleAccount,
  daysAhead: number = 1
): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: account.auth });
  const now = new Date();
  const until = new Date(now);
  until.setDate(until.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 20,
  });

  const events = res.data.items ?? [];
  if (events.length === 0) {
    return `No events in the next ${daysAhead} day(s) for ${account.email}`;
  }

  return events.map((e) => formatEvent(e)).join("\n\n");
}

export async function calendarCreate(
  account: GoogleAccount,
  summary: string,
  startTime: string,
  endTime: string,
  description?: string,
  attendees?: string[]
): Promise<string> {
  const calendar = google.calendar({ version: "v3", auth: account.auth });

  const event = {
    summary,
    description: description ?? "",
    start: parseEventTime(startTime),
    end: parseEventTime(endTime),
    attendees: attendees?.map((email) => ({ email })),
  };

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });

  return `Event created: "${summary}" (${res.data.htmlLink})`;
}

function parseEventTime(time: string): { dateTime: string; timeZone: string } {
  return {
    dateTime: new Date(time).toISOString(),
    timeZone: "Asia/Kolkata",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatEvent(event: any): string {
  const start = event.start?.dateTime ?? event.start?.date ?? "?";
  const end = event.end?.dateTime ?? event.end?.date ?? "?";
  const attendees = (event.attendees ?? [])
    .map((a: { email: string }) => a.email)
    .join(", ");

  const parts = [
    `Event: ${event.summary ?? "(no title)"}`,
    `When: ${start} → ${end}`,
  ];

  if (event.location) parts.push(`Where: ${event.location}`);
  if (attendees) parts.push(`Attendees: ${attendees}`);
  if (event.description) parts.push(`Notes: ${event.description.slice(0, 200)}`);

  return parts.join("\n");
}
