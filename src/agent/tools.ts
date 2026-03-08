import type Database from "better-sqlite3";
import type { MarkdownMemory } from "../memory/markdown.js";
import { searchMemory } from "../memory/search.js";
import { peopleSearch, peopleUpsert, peopleLog } from "../people/tools.js";
import { gmailSearch, gmailRead, gmailSend } from "../services/gmail.js";
import { calendarList, calendarCreate } from "../services/calendar.js";
import { findAccount, type GoogleAccount } from "../services/google-auth.js";
import { searchFlights, searchAirportCode } from "../services/flights.js";
import { webSearch, webFetch } from "../services/web.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";

export interface ToolContext {
  db: Database.Database;
  memory: MarkdownMemory;
  profilesDir: string;
  googleAccounts: GoogleAccount[];
  amadeusClientId: string;
  amadeusClientSecret: string;
}

type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

function resolveAccount(accounts: GoogleAccount[], accountHint?: string): GoogleAccount {
  if (accounts.length === 0) throw new Error("No Google accounts configured");
  if (!accountHint) return accounts[0]!;
  const found = findAccount(accounts, accountHint);
  return found ?? accounts[0]!;
}

export function createToolHandlers(ctx: ToolContext): Record<string, ToolHandler> {
  return {
    exec: (args) => toolExec(args["command"] as string),
    read_file: (args) => toolReadFile(args["path"] as string),
    write_file: (args) => toolWriteFile(args["path"] as string, args["content"] as string),
    memory_search: (args) => toolMemorySearch(ctx.db, args["query"] as string),
    memory_save: (args) => toolMemorySave(ctx.memory, args["content"] as string),
    people_search: (args) => peopleSearch(ctx.db, args["query"] as string),
    people_upsert: (args) => peopleUpsert(ctx.db, ctx.profilesDir, args as never),
    people_log: (args) => peopleLog(ctx.db, ctx.profilesDir, args as never),
    gmail_search: async (args) => {
      const accountHint = args["account"] as string | undefined;
      const query = args["query"] as string;
      const max = (args["max_results"] as number) ?? 10;

      if (accountHint) {
        const acct = resolveAccount(ctx.googleAccounts, accountHint);
        return gmailSearch(acct, query, max);
      }

      // Search all accounts in parallel
      const promises = ctx.googleAccounts.map(async (acct) => {
        const r = await gmailSearch(acct, query, max);
        return `--- ${acct.email} ---\n${r}`;
      });
      const results = await Promise.all(promises);
      return results.join("\n\n");
    },
    gmail_read: async (args) => {
      const accountHint = args["account"] as string | undefined;
      const messageId = args["message_id"] as string;

      if (accountHint) {
        const acct = resolveAccount(ctx.googleAccounts, accountHint);
        return gmailRead(acct, messageId);
      }

      // Try each account until one works
      for (const acct of ctx.googleAccounts) {
        try {
          return await gmailRead(acct, messageId);
        } catch {
          continue;
        }
      }
      return `Could not read message ${messageId} from any account.`;
    },
    gmail_send: (args) => {
      const acct = resolveAccount(ctx.googleAccounts, args["account"] as string | undefined);
      return gmailSend(acct, args["to"] as string, args["subject"] as string, args["body"] as string, args["thread_id"] as string | undefined);
    },
    calendar_list: async (args) => {
      const accountHint = args["account"] as string | undefined;
      const days = (args["days_ahead"] as number) ?? 1;

      if (accountHint) {
        const acct = resolveAccount(ctx.googleAccounts, accountHint);
        return calendarList(acct, days);
      }

      // Search all accounts in parallel
      const promises = ctx.googleAccounts.map(async (acct) => {
        const r = await calendarList(acct, days);
        return `--- ${acct.email} ---\n${r}`;
      });
      const results = await Promise.all(promises);
      return results.join("\n\n");
    },
    calendar_create: (args) => {
      const acct = resolveAccount(ctx.googleAccounts, args["account"] as string | undefined);
      return calendarCreate(
        acct, args["summary"] as string, args["start_time"] as string,
        args["end_time"] as string, args["description"] as string | undefined,
        args["attendees"] as string[] | undefined
      );
    },
    flight_search: (args) => {
      return searchFlights(ctx.amadeusClientId, ctx.amadeusClientSecret, {
        origin: args["origin"] as string,
        destination: args["destination"] as string,
        departureDate: args["departure_date"] as string,
        returnDate: args["return_date"] as string | undefined,
        adults: (args["adults"] as number) ?? 1,
        maxResults: (args["max_results"] as number) ?? 5,
      });
    },
    airport_search: (args) => {
      return searchAirportCode(ctx.amadeusClientId, ctx.amadeusClientSecret, args["keyword"] as string);
    },
    deep_search: async (args) => {
      const query = args["query"] as string;
      const sources = (args["sources"] as string[] | undefined) ?? ["email", "memory", "people"];
      const t0 = performance.now();

      console.log(`[deep_search] query="${query}" sources=${sources.join(",")}`);

      const sections: string[] = [];

      // Fan out ALL sources in parallel
      const emailQueries = sources.includes("email") ? expandQuery(query) : [];
      const webQueries = sources.includes("web") ? expandWebQuery(query) : [];

      const promises: { source: string; promise: Promise<string> }[] = [];

      // Email: multiple queries × all accounts
      for (const eq of emailQueries) {
        for (const acct of ctx.googleAccounts) {
          promises.push({
            source: `email:${acct.email}`,
            promise: gmailSearch(acct, eq, 5).catch(() => ""),
          });
        }
      }

      // Web: multiple query variations in parallel
      for (const wq of webQueries) {
        promises.push({
          source: "web",
          promise: webSearch(wq).catch(() => ""),
        });
      }

      // Memory + People (instant, local)
      if (sources.includes("memory")) {
        promises.push({ source: "memory", promise: Promise.resolve(toolMemorySearch(ctx.db, query)) });
      }
      if (sources.includes("people")) {
        promises.push({ source: "people", promise: Promise.resolve(peopleSearch(ctx.db, query)) });
      }

      const results = await Promise.all(
        promises.map(async (p) => ({ source: p.source, result: await p.promise }))
      );

      // --- Process email results ---
      const seenIds = new Set<string>();
      const emailHits: { account: string; id: string; subject: string; date: string; from: string; snippet: string }[] = [];

      for (const r of results) {
        if (!r.source.startsWith("email:")) continue;
        const account = r.source.replace("email:", "");
        for (const block of r.result.split("\n\n")) {
          const idMatch = block.match(/ID:\s*(\S+)/);
          if (!idMatch || seenIds.has(idMatch[1]!)) continue;
          seenIds.add(idMatch[1]!);
          const subjMatch = block.match(/Subject:\s*(.+)/);
          const dateMatch = block.match(/\[(.+?)\]/);
          const fromMatch = block.match(/From:\s*(.+)/);
          const snippetMatch = block.match(/Snippet:\s*(.+)/);
          emailHits.push({
            account, id: idMatch[1]!,
            subject: subjMatch?.[1] ?? "", date: dateMatch?.[1] ?? "",
            from: fromMatch?.[1] ?? "", snippet: snippetMatch?.[1] ?? "",
          });
        }
      }

      if (emailHits.length > 0) {
        const MAX_READ = 3;
        // Auto-read top results in parallel
        const top = emailHits.slice(0, MAX_READ);
        const readResults = await Promise.all(top.map(async (hit) => {
          const acct = ctx.googleAccounts.find((a) => a.email === hit.account);
          if (!acct) return `[${hit.date}] ${hit.subject}`;
          try {
            return await gmailRead(acct, hit.id);
          } catch {
            return `[${hit.date}] From: ${hit.from}\nSubject: ${hit.subject}\nSnippet: ${hit.snippet}`;
          }
        }));
        sections.push(`## Email (${emailHits.length} results, ${top.length} read)\n${readResults.join("\n---\n")}`);

        if (emailHits.length > MAX_READ) {
          const rest = emailHits.slice(MAX_READ).map((h) => `- [${h.date}] ${h.subject} (${h.account})`);
          sections.push(`### More email matches\n${rest.join("\n")}`);
        }
      } else if (sources.includes("email")) {
        sections.push("## Email\nNo matching emails found.");
      }

      // --- Process web results ---
      const seenUrls = new Set<string>();
      const webItems: { title: string; url: string; snippet: string }[] = [];

      for (const r of results) {
        if (r.source !== "web" || !r.result) continue;
        for (const block of r.result.split("\n\n")) {
          const lines = block.split("\n");
          if (lines.length < 2) continue;
          const title = lines[0] ?? "";
          const url = lines[1] ?? "";
          if (url.startsWith("http") && !seenUrls.has(url)) {
            seenUrls.add(url);
            webItems.push({ title, url, snippet: lines.slice(2).join(" ") });
          }
        }
      }

      if (webItems.length > 0) {
        // Auto-fetch top 3 pages in parallel
        const MAX_FETCH = 3;
        const fetched = await Promise.all(
          webItems.slice(0, MAX_FETCH).map(async (item) => {
            try {
              const content = await webFetch(item.url);
              return `### ${item.title}\n${item.url}\n${content.slice(0, 3000)}`;
            } catch {
              return `### ${item.title}\n${item.url}\n${item.snippet}`;
            }
          })
        );
        const rest = webItems.slice(MAX_FETCH, 8).map((i) => `- ${i.title} — ${i.url}`);
        sections.push(`## Web (${webItems.length} results, ${Math.min(MAX_FETCH, webItems.length)} read)\n${fetched.join("\n---\n")}${rest.length > 0 ? "\n### More\n" + rest.join("\n") : ""}`);
      }

      // --- Memory & People ---
      for (const r of results) {
        if (r.source === "memory" && r.result !== "No memories found.") {
          sections.push(`## Memory\n${r.result}`);
        }
        if (r.source === "people" && !r.result.includes("No people found")) {
          sections.push(`## People\n${r.result}`);
        }
      }

      const elapsed = (performance.now() - t0).toFixed(0);
      console.log(`[deep_search] done in ${elapsed}ms | ${emailHits.length} emails, ${webItems.length} web, ${sections.length} sections`);

      if (sections.length === 0) {
        return `No results found for "${query}" across ${sources.join(", ")}.`;
      }

      return sections.join("\n\n");
    },
  };
}

function toolExec(command: string): string {
  try {
    const output = execSync(command, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });
    return output.slice(0, 4000);
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return `Error: ${err.stderr ?? err.message}`.slice(0, 2000);
  }
}

function toolReadFile(path: string): string {
  if (!existsSync(path)) return `File not found: ${path}`;
  const content = readFileSync(path, "utf-8");
  if (content.length > 8000) {
    return content.slice(0, 8000) + "\n... (truncated)";
  }
  return content;
}

function toolWriteFile(path: string, content: string): string {
  writeFileSync(path, content);
  return `Written ${content.length} bytes to ${path}`;
}

function toolMemorySearch(db: Database.Database, query: string): string {
  const results = searchMemory(db, query);
  if (results.length === 0) return "No memories found.";
  return results
    .map((r) => `[${r.path}:${r.startLine}-${r.endLine}] ${r.snippet}`)
    .join("\n");
}

function toolMemorySave(memory: MarkdownMemory, content: string): string {
  memory.appendToDaily(content);
  return `Saved to daily log for ${memory.todayDate()}`;
}

/** Generate expanded email queries from a natural language query */
function expandQuery(query: string): string[] {
  const q = query.toLowerCase();
  const queries = [query]; // Always include original

  // Travel/flight patterns
  if (q.includes("flight") || q.includes("travel") || q.includes("trip") || q.includes("book")) {
    queries.push("(flight OR booking OR itinerary OR e-ticket OR PNR OR confirmation)");
    queries.push("(IndiGo OR \"Air India\" OR SpiceJet OR Vistara OR Akasa OR \"Thai Airways\" OR Emirates OR Lufthansa OR Singapore)");
  }

  // Hotel/accommodation
  if (q.includes("hotel") || q.includes("stay") || q.includes("accommodation") || q.includes("trip")) {
    queries.push("(hotel OR reservation OR check-in OR Marriott OR Hilton OR Airbnb OR OYO)");
  }

  // Meeting/calendar
  if (q.includes("meeting") || q.includes("schedule") || q.includes("calendar")) {
    queries.push("(meeting OR invite OR agenda OR calendar OR zoom OR teams)");
  }

  // Finance/payment
  if (q.includes("payment") || q.includes("invoice") || q.includes("bill") || q.includes("money")) {
    queries.push("(invoice OR payment OR receipt OR transaction OR bill)");
  }

  // Limit to max 3 queries to stay fast
  return queries.slice(0, 3);
}

/** Generate expanded web search queries from a natural language query */
function expandWebQuery(query: string): string[] {
  const queries = [query];
  const q = query.toLowerCase();

  if (q.includes("restaurant") || q.includes("food") || q.includes("eat") || q.includes("cafe")) {
    queries.push(`best ${query} reviews ratings 2026`);
    queries.push(`${query} Zomato OR TripAdvisor OR Google reviews`);
  } else if (q.includes("hotel") || q.includes("stay") || q.includes("resort")) {
    queries.push(`${query} reviews booking.com OR TripAdvisor 2026`);
    queries.push(`best ${query} recommendations`);
  } else if (q.includes("when") || q.includes("date") || q.includes("schedule")) {
    queries.push(`${query} official website`);
    queries.push(`${query} Wikipedia`);
  } else if (q.includes("how to") || q.includes("guide") || q.includes("tutorial")) {
    queries.push(`${query} step by step guide`);
    queries.push(`${query} Reddit OR StackOverflow`);
  } else {
    queries.push(`${query} 2026`);
    queries.push(`${query} site:reddit.com OR site:wikipedia.org`);
  }

  return queries.slice(0, 4);
}

const S = SchemaType;

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "exec",
    description: "Run a shell command and return output. Use for system tasks, checking status, etc.",
    parameters: {
      type: S.OBJECT,
      properties: { command: { type: S.STRING, description: "Shell command to run" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read contents of a file at the given path.",
    parameters: {
      type: S.OBJECT,
      properties: { path: { type: S.STRING, description: "Absolute file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating or overwriting it.",
    parameters: {
      type: S.OBJECT,
      properties: {
        path: { type: S.STRING, description: "Absolute file path" },
        content: { type: S.STRING, description: "File content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_search",
    description: "Search past memories and daily logs for information.",
    parameters: {
      type: S.OBJECT,
      properties: { query: { type: S.STRING, description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "memory_save",
    description: "Save important information to today's daily log for future reference.",
    parameters: {
      type: S.OBJECT,
      properties: { content: { type: S.STRING, description: "Content to save" } },
      required: ["content"],
    },
  },
  {
    name: "people_search",
    description: "Search the people database for contacts, their info, and past interactions.",
    parameters: {
      type: S.OBJECT,
      properties: { query: { type: S.STRING, description: "Name, org, or topic to search" } },
      required: ["query"],
    },
  },
  {
    name: "people_upsert",
    description: "Create or update a person's record in the people database.",
    parameters: {
      type: S.OBJECT,
      properties: {
        name: { type: S.STRING, description: "Person's full name" },
        email: { type: S.STRING, description: "Email address" },
        org: { type: S.STRING, description: "Organization" },
        role: { type: S.STRING, description: "Job title or role" },
        notes: { type: S.STRING, description: "Additional notes" },
      },
      required: ["name"],
    },
  },
  {
    name: "people_log",
    description: "Log an interaction with a person (from email, meeting, call, etc).",
    parameters: {
      type: S.OBJECT,
      properties: {
        name: { type: S.STRING, description: "Person's name" },
        source: { type: S.STRING, description: "Source: email, meeting, telegram, call" },
        summary: { type: S.STRING, description: "Brief summary of the interaction" },
        date: { type: S.STRING, description: "Date in YYYY-MM-DD format (defaults to today)" },
      },
      required: ["name", "source", "summary"],
    },
  },
  {
    name: "gmail_search",
    description: "Search emails in Gmail. Searches ALL accounts unless a specific account is given. Gmail searches subject, body text, sender, and attachments by default. Pass simple keywords WITHOUT quotes for broad search (e.g. 'lizard island' not '\"lizard island\"'). Supports operators: from:, to:, subject:, is:unread, has:attachment, after:2026/01/01.",
    parameters: {
      type: S.OBJECT,
      properties: {
        query: { type: S.STRING, description: "Gmail search query" },
        account: { type: S.STRING, description: "Email account to search (optional, defaults to primary)" },
        max_results: { type: S.INTEGER, description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read",
    description: "Read the full content of a specific email by message ID.",
    parameters: {
      type: S.OBJECT,
      properties: {
        message_id: { type: S.STRING, description: "Gmail message ID" },
        account: { type: S.STRING, description: "Email account (optional)" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_send",
    description: "Send an email or reply to a thread.",
    parameters: {
      type: S.OBJECT,
      properties: {
        to: { type: S.STRING, description: "Recipient email address" },
        subject: { type: S.STRING, description: "Email subject" },
        body: { type: S.STRING, description: "Email body text" },
        account: { type: S.STRING, description: "Send from this account (optional)" },
        thread_id: { type: S.STRING, description: "Thread ID to reply to (optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_list",
    description: "List upcoming calendar events. Shows ALL accounts unless a specific account is given.",
    parameters: {
      type: S.OBJECT,
      properties: {
        days_ahead: { type: S.INTEGER, description: "Number of days ahead to look (default 1)" },
        account: { type: S.STRING, description: "Calendar account (optional)" },
      },
      required: [],
    },
  },
  {
    name: "calendar_create",
    description: "Create a new calendar event.",
    parameters: {
      type: S.OBJECT,
      properties: {
        summary: { type: S.STRING, description: "Event title" },
        start_time: { type: S.STRING, description: "Start time (ISO 8601 or natural like '2026-03-08T10:00:00')" },
        end_time: { type: S.STRING, description: "End time" },
        description: { type: S.STRING, description: "Event description (optional)" },
        attendees: { type: S.ARRAY, description: "List of attendee emails", items: { type: S.STRING } },
        account: { type: S.STRING, description: "Calendar account (optional)" },
      },
      required: ["summary", "start_time", "end_time"],
    },
  },
  {
    name: "flight_search",
    description: "Search for flights between airports. Use IATA airport codes (e.g. BLR, SYD, LZR). If you don't know the code, use airport_search first. Dates must be YYYY-MM-DD format. IMPORTANT: Always present the FULL flight results to the user — show every option with airline, flight number, times, stops, duration, and price. Never summarize or skip flights.",
    parameters: {
      type: S.OBJECT,
      properties: {
        origin: { type: S.STRING, description: "Origin airport IATA code (e.g. BLR)" },
        destination: { type: S.STRING, description: "Destination airport IATA code (e.g. SYD)" },
        departure_date: { type: S.STRING, description: "Departure date YYYY-MM-DD" },
        return_date: { type: S.STRING, description: "Return date YYYY-MM-DD (optional for one-way)" },
        adults: { type: S.INTEGER, description: "Number of adult passengers (default 1)" },
        max_results: { type: S.INTEGER, description: "Max flight options to return (default 5)" },
      },
      required: ["origin", "destination", "departure_date"],
    },
  },
  {
    name: "airport_search",
    description: "Look up IATA airport codes by city or airport name. Use this when you need to find the airport code for a city.",
    parameters: {
      type: S.OBJECT,
      properties: {
        keyword: { type: S.STRING, description: "City name or airport name to search" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "deep_search",
    description: "Search personal data sources in ONE call. Searches email (both accounts, query-expanded), memory, and people — all in parallel. Use for finding emails, past conversations, contacts. Do NOT use for general knowledge questions — answer those yourself from your training data.",
    parameters: {
      type: S.OBJECT,
      properties: {
        query: { type: S.STRING, description: "Natural language search query (e.g. 'flight booking', 'meeting with John', 'invoice from AWS')" },
        sources: {
          type: S.ARRAY,
          description: "Sources to search: email, memory, people. Defaults to all three.",
          items: { type: S.STRING },
        },
      },
      required: ["query"],
    },
  },
];
