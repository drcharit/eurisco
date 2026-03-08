import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext } from "./types.js";
import { searchMemory } from "../memory/search.js";
import { peopleSearch, peopleUpsert, peopleLog } from "../people/tools.js";
import { gmailSearch, gmailRead } from "../services/gmail.js";
import { webSearch, webFetch } from "../services/web.js";

const S = SchemaType;

export const knowledgeSkill: Skill = {
  name: "knowledge",
  description:
    "Search across all personal data (email, memory, people, web) in one parallel call. " +
    "Also: save memories, manage contacts. Use deep_search as the first tool for any information-finding task.",

  tools: [
    {
      name: "deep_search",
      description:
        "Universal search across ALL sources in ONE call. Searches email (both accounts, query-expanded), " +
        "web (multiple queries, auto-fetches top pages), memory, and people — all in parallel. " +
        "This is the ONLY search tool you need for broad queries. After calling, STOP — do not search again.",
      parameters: {
        type: S.OBJECT,
        properties: {
          query: {
            type: S.STRING,
            description: "Natural language query (e.g. 'flight booking', 'meeting with John')",
          },
          sources: {
            type: S.ARRAY,
            description:
              "Sources: email, web, memory, people. Default: all four. " +
              "Use ['email','memory','people'] for personal queries, ['web'] for general info.",
            items: { type: S.STRING },
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_search",
      description: "Search past memories and daily logs.",
      parameters: {
        type: S.OBJECT,
        properties: { query: { type: S.STRING, description: "Search query" } },
        required: ["query"],
      },
    },
    {
      name: "memory_save",
      description: "Save important information to daily log for future reference.",
      parameters: {
        type: S.OBJECT,
        properties: { content: { type: S.STRING, description: "Content to save" } },
        required: ["content"],
      },
    },
    {
      name: "people_search",
      description: "Search the people database for contacts and interactions.",
      parameters: {
        type: S.OBJECT,
        properties: { query: { type: S.STRING, description: "Name, org, or topic" } },
        required: ["query"],
      },
    },
    {
      name: "people_upsert",
      description: "Create or update a person's record.",
      parameters: {
        type: S.OBJECT,
        properties: {
          name: { type: S.STRING, description: "Full name" },
          email: { type: S.STRING, description: "Email" },
          org: { type: S.STRING, description: "Organization" },
          role: { type: S.STRING, description: "Job title" },
          notes: { type: S.STRING, description: "Notes" },
        },
        required: ["name"],
      },
    },
    {
      name: "people_log",
      description: "Log an interaction with a person.",
      parameters: {
        type: S.OBJECT,
        properties: {
          name: { type: S.STRING, description: "Person's name" },
          source: { type: S.STRING, description: "Source: email, meeting, telegram, call" },
          summary: { type: S.STRING, description: "Brief summary" },
          date: { type: S.STRING, description: "Date YYYY-MM-DD (default today)" },
        },
        required: ["name", "source", "summary"],
      },
    },
  ] as FunctionDeclaration[],

  createHandlers(ctx: ToolContext) {
    return {
      deep_search: (args: Record<string, unknown>) =>
        deepSearch(ctx, args["query"] as string, args["sources"] as string[] | undefined),

      memory_search: (args: Record<string, unknown>) => {
        const results = searchMemory(ctx.db, args["query"] as string);
        if (results.length === 0) return "No memories found.";
        return results.map((r) => `[${r.path}:${r.startLine}-${r.endLine}] ${r.snippet}`).join("\n");
      },

      memory_save: (args: Record<string, unknown>) => {
        ctx.memory.appendToDaily(args["content"] as string);
        return `Saved to daily log for ${ctx.memory.todayDate()}`;
      },

      people_search: (args: Record<string, unknown>) => peopleSearch(ctx.db, args["query"] as string),
      people_upsert: (args: Record<string, unknown>) => peopleUpsert(ctx.db, ctx.profilesDir, args as never),
      people_log: (args: Record<string, unknown>) => peopleLog(ctx.db, ctx.profilesDir, args as never),
    };
  },
};

// ─── deep_search implementation ─────────────────────────────────────────────

async function deepSearch(
  ctx: ToolContext,
  query: string,
  sourcesArg?: string[],
): Promise<string> {
  const sources = sourcesArg ?? ["email", "memory", "people", "web"];
  const t0 = performance.now();
  console.log(`[deep_search] query="${query}" sources=${sources.join(",")}`);

  const sections: string[] = [];
  const emailQueries = sources.includes("email") ? expandQuery(query) : [];
  const webQueries = sources.includes("web") ? expandWebQuery(query) : [];

  const promises: { source: string; promise: Promise<string> }[] = [];

  // Email: expanded queries × all accounts
  for (const eq of emailQueries) {
    for (const acct of ctx.googleAccounts) {
      promises.push({
        source: `email:${acct.email}`,
        promise: gmailSearch(acct, eq, 5).catch(() => ""),
      });
    }
  }

  // Web: multiple query variations
  for (const wq of webQueries) {
    promises.push({ source: "web", promise: webSearch(wq).catch(() => "") });
  }

  // Memory + People (local, instant)
  if (sources.includes("memory")) {
    const results = searchMemory(ctx.db, query);
    const text = results.length === 0
      ? "No memories found."
      : results.map((r) => `[${r.path}:${r.startLine}-${r.endLine}] ${r.snippet}`).join("\n");
    promises.push({ source: "memory", promise: Promise.resolve(text) });
  }
  if (sources.includes("people")) {
    promises.push({ source: "people", promise: Promise.resolve(peopleSearch(ctx.db, query)) });
  }

  const results = await Promise.all(
    promises.map(async (p) => ({ source: p.source, result: await p.promise })),
  );

  // --- Email results ---
  const seenIds = new Set<string>();
  const emailHits: {
    account: string; id: string; subject: string;
    date: string; from: string; snippet: string;
  }[] = [];

  for (const r of results) {
    if (!r.source.startsWith("email:")) continue;
    const account = r.source.replace("email:", "");
    for (const block of r.result.split("\n\n")) {
      const idMatch = block.match(/ID:\s*(\S+)/);
      if (!idMatch || seenIds.has(idMatch[1]!)) continue;
      seenIds.add(idMatch[1]!);
      emailHits.push({
        account,
        id: idMatch[1]!,
        subject: block.match(/Subject:\s*(.+)/)?.[1] ?? "",
        date: block.match(/\[(.+?)\]/)?.[1] ?? "",
        from: block.match(/From:\s*(.+)/)?.[1] ?? "",
        snippet: block.match(/Snippet:\s*(.+)/)?.[1] ?? "",
      });
    }
  }

  if (emailHits.length > 0) {
    const MAX_READ = 5;
    const top = emailHits.slice(0, MAX_READ);
    const readResults = await Promise.all(
      top.map(async (hit) => {
        const acct = ctx.googleAccounts.find((a) => a.email === hit.account);
        if (!acct) return `[${hit.date}] ${hit.subject}`;
        try {
          return await gmailRead(acct, hit.id);
        } catch {
          return `[${hit.date}] From: ${hit.from}\nSubject: ${hit.subject}\nSnippet: ${hit.snippet}`;
        }
      }),
    );
    sections.push(`## Email (${emailHits.length} found, ${top.length} read)\n${readResults.join("\n---\n")}`);

    if (emailHits.length > MAX_READ) {
      const rest = emailHits.slice(MAX_READ).map((h) => `- [${h.date}] ${h.subject} (${h.account})`);
      sections.push(`### More email matches\n${rest.join("\n")}`);
    }
  } else if (sources.includes("email")) {
    sections.push("## Email\nNo matching emails found.");
  }

  // --- Web results ---
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
    const MAX_FETCH = 3;
    const fetched = await Promise.all(
      webItems.slice(0, MAX_FETCH).map(async (item) => {
        try {
          const content = await webFetch(item.url);
          return `### ${item.title}\n${item.url}\n${content.slice(0, 4000)}`;
        } catch {
          return `### ${item.title}\n${item.url}\n${item.snippet}`;
        }
      }),
    );
    const rest = webItems.slice(MAX_FETCH, 8).map((i) => `- ${i.title} — ${i.url}`);
    sections.push(
      `## Web (${webItems.length} found, ${Math.min(MAX_FETCH, webItems.length)} read)\n` +
        fetched.join("\n---\n") +
        (rest.length > 0 ? "\n### More\n" + rest.join("\n") : ""),
    );
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
}

// ─── Query expansion ────────────────────────────────────────────────────────

function expandQuery(query: string): string[] {
  const q = query.toLowerCase();
  const queries = [query];

  if (q.includes("flight") || q.includes("travel") || q.includes("trip") || q.includes("book")) {
    queries.push("(flight OR booking OR itinerary OR e-ticket OR PNR OR confirmation)");
    queries.push('(IndiGo OR "Air India" OR SpiceJet OR Vistara OR Akasa OR Emirates OR Singapore)');
  }
  if (q.includes("hotel") || q.includes("stay") || q.includes("accommodation") || q.includes("trip")) {
    queries.push("(hotel OR reservation OR check-in OR Marriott OR Hilton OR Airbnb)");
  }
  if (q.includes("meeting") || q.includes("schedule") || q.includes("calendar")) {
    queries.push("(meeting OR invite OR agenda OR calendar OR zoom OR teams)");
  }
  if (q.includes("payment") || q.includes("invoice") || q.includes("bill") || q.includes("money")) {
    queries.push("(invoice OR payment OR receipt OR transaction OR bill)");
  }
  return queries.slice(0, 3);
}

function expandWebQuery(query: string): string[] {
  const queries = [query];
  const q = query.toLowerCase();

  if (q.includes("restaurant") || q.includes("food") || q.includes("eat") || q.includes("cafe")) {
    queries.push(`best ${query} reviews ratings 2026`);
    queries.push(`${query} Zomato OR TripAdvisor OR Google reviews`);
  } else if (q.includes("hotel") || q.includes("stay") || q.includes("resort")) {
    queries.push(`${query} reviews booking.com OR TripAdvisor 2026`);
    queries.push(`best ${query} recommendations`);
  } else if (q.includes("how to") || q.includes("guide") || q.includes("tutorial")) {
    queries.push(`${query} step by step guide`);
    queries.push(`${query} Reddit OR StackOverflow`);
  } else {
    queries.push(`${query} 2026`);
    queries.push(`${query} site:reddit.com OR site:wikipedia.org`);
  }
  return queries.slice(0, 4);
}
