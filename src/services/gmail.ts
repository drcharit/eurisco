import { google } from "googleapis";
import type { GoogleAccount } from "./google-auth.js";

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailContent {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
}

export async function gmailSearch(
  account: GoogleAccount,
  query: string,
  maxResults: number = 10
): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: account.auth });
  console.log(`[gmail_search] account=${account.email} query="${query}"`);
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  const messages = res.data.messages ?? [];
  if (messages.length === 0) return `No emails found for "${query}" in ${account.email}. Gmail searches subject, body, sender, and attachments. Try broader keywords.`;

  const MAX_FETCH = Math.min(messages.length, maxResults);
  const ids = messages.slice(0, MAX_FETCH).map((m) => m.id).filter(Boolean) as string[];

  // Fetch metadata in parallel
  const summaries = await Promise.all(
    ids.map(async (msgId) => {
      const msg = await gmail.users.messages.get({ userId: "me", id: msgId, format: "metadata" });
      return parseHeaders(msgId, msg.data);
    })
  );

  return summaries
    .map((s) => `[${s.date}] From: ${s.from}\nSubject: ${s.subject}\nSnippet: ${s.snippet}\nID: ${s.id}\nAccount: ${account.email}`)
    .join("\n\n");
}

export async function gmailRead(account: GoogleAccount, messageId: string): Promise<string> {
  console.log(`[gmail_read] account=${account.email} id=${messageId}`);
  const gmail = google.gmail({ version: "v1", auth: account.auth });
  const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });

  const headers = parseHeaders(messageId, msg.data);
  let body = extractBody(msg.data);

  // Truncate large emails to avoid overwhelming the model
  const MAX_BODY = 6000;
  if (body.length > MAX_BODY) {
    body = body.slice(0, MAX_BODY) + "\n... (truncated, original was " + body.length + " chars)";
  }

  console.log(`[gmail_read] body length=${body.length}`);

  return [
    `From: ${headers.from}`,
    `Subject: ${headers.subject}`,
    `Date: ${headers.date}`,
    `\n${body}`,
  ].join("\n");
}

export async function gmailSend(
  account: GoogleAccount,
  to: string,
  subject: string,
  body: string,
  threadId?: string
): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: account.auth });

  const message = [
    `To: ${to}`,
    `From: ${account.email}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const encoded = Buffer.from(message).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, threadId },
  });

  return `Email sent to ${to} from ${account.email}`;
}

function parseHeaders(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
): EmailSummary {
  const headers = data.payload?.headers ?? [];
  const get = (name: string): string =>
    headers.find((h: { name: string }) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  return {
    id,
    threadId: data.threadId ?? "",
    from: get("From"),
    subject: get("Subject"),
    date: get("Date"),
    snippet: data.snippet ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractBody(data: any): string {
  const payload = data.payload;
  if (!payload) return "(no body)";

  // Collect all leaf parts (flatten nested multipart)
  const leaves: { mimeType: string; data: string }[] = [];
  collectParts(payload, leaves);

  // Prefer text/plain
  const plain = leaves.find((p) => p.mimeType === "text/plain");
  if (plain) {
    return Buffer.from(plain.data, "base64url").toString("utf-8");
  }

  // Fall back to text/html → strip tags
  const html = leaves.find((p) => p.mimeType === "text/html");
  if (html) {
    const decoded = Buffer.from(html.data, "base64url").toString("utf-8");
    return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  // Last resort: use snippet from API
  return data.snippet ?? "(no readable body)";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectParts(part: any, leaves: { mimeType: string; data: string }[]): void {
  const MAX_DEPTH = 5;
  const stack: { part: any; depth: number }[] = [{ part, depth: 0 }];

  for (let i = 0; i < 50 && i < stack.length; i++) {
    const { part: p, depth } = stack[i]!;
    if (depth > MAX_DEPTH) continue;

    if (p.body?.data) {
      leaves.push({ mimeType: p.mimeType ?? "", data: p.body.data });
    }

    for (const sub of p.parts ?? []) {
      stack.push({ part: sub, depth: depth + 1 });
    }
  }
}
