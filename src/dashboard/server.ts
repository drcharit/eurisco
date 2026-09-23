import { createServer } from "node:http";
import type Database from "better-sqlite3";
import type { GoogleAccount } from "../services/google-auth.js";
import {
  listPeople, getPerson, getOverdue, getStats,
  getTypes, getOrgs, getPersonEmails, readEmail,
  sendEmail, getAccounts,
} from "./api.js";
import { renderHTML } from "./ui.js";

export function startDashboard(
  db: Database.Database,
  accounts: GoogleAccount[],
  port: number = 3000
): void {
  const html = renderHTML();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = url.pathname;

    // CORS + JSON headers for API
    if (path.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
    }

    try {
      // ── Static HTML ──
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      // ── API Routes ──

      if (path === "/api/stats") {
        json(res, getStats(db));
        return;
      }

      if (path === "/api/people") {
        const filters = {
          type: url.searchParams.get("type") ?? undefined,
          org: url.searchParams.get("org") ?? undefined,
          search: url.searchParams.get("q") ?? undefined,
        };
        json(res, listPeople(db, filters));
        return;
      }

      if (path === "/api/overdue") {
        json(res, getOverdue(db));
        return;
      }

      if (path === "/api/types") {
        json(res, getTypes(db));
        return;
      }

      if (path === "/api/orgs") {
        json(res, getOrgs(db));
        return;
      }

      if (path === "/api/accounts") {
        json(res, getAccounts(accounts));
        return;
      }

      // /api/people/:slug
      const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
      if (personMatch && req.method === "GET") {
        const data = getPerson(db, personMatch[1]!);
        if (!data) { notFound(res); return; }
        json(res, data);
        return;
      }

      // /api/people/:slug/emails
      const emailsMatch = path.match(/^\/api\/people\/([^/]+)\/emails$/);
      if (emailsMatch) {
        const data = getPerson(db, emailsMatch[1]!);
        if (!data) { notFound(res); return; }
        const email = data.emails[0] ?? data.person.email;
        if (!email) { json(res, []); return; }
        const results = await getPersonEmails(accounts, email);
        json(res, results);
        return;
      }

      // /api/email/read?id=...&account=...
      if (path === "/api/email/read") {
        const id = url.searchParams.get("id");
        const account = url.searchParams.get("account");
        if (!id || !account) { badRequest(res, "Missing id or account"); return; }
        const result = await readEmail(accounts, account, id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(result);
        return;
      }

      // POST /api/email/send
      if (path === "/api/email/send" && req.method === "POST") {
        const body = await readBody(req);
        const { account, to, subject, text, threadId } = JSON.parse(body);
        if (!account || !to || !subject || !text) {
          badRequest(res, "Missing required fields");
          return;
        }
        const result = await sendEmail(accounts, account, to, subject, text, threadId);
        json(res, { success: true, message: result });
        return;
      }

      notFound(res);
    } catch (e) {
      const err = e as Error;
      console.error(`[dashboard] Error: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log(`\n  People CRM Dashboard: http://localhost:${port}\n`);
  });
}

function json(res: import("node:http").ServerResponse, data: unknown): void {
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

function notFound(res: import("node:http").ServerResponse): void {
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
}

function badRequest(res: import("node:http").ServerResponse, msg: string): void {
  res.writeHead(400);
  res.end(JSON.stringify({ error: msg }));
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
