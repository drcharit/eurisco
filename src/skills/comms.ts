import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext } from "./types.js";
import { gmailSearch, gmailRead, gmailSend } from "../services/gmail.js";
import { calendarList, calendarCreate } from "../services/calendar.js";
import { findAccount } from "../services/google-auth.js";
import type { GoogleAccount } from "../services/google-auth.js";

const S = SchemaType;

function resolveAccount(accounts: GoogleAccount[], hint?: string): GoogleAccount {
  if (accounts.length === 0) throw new Error("No Google accounts configured");
  if (!hint) return accounts[0]!;
  return findAccount(accounts, hint) ?? accounts[0]!;
}

export const commsSkill: Skill = {
  name: "comms",
  description:
    "Email and calendar. Search/read/send Gmail across all accounts, list/create calendar events. " +
    "Use deep_search instead for broad queries — use these for targeted follow-ups.",

  tools: [
    {
      name: "gmail_search",
      description:
        "Search emails in Gmail. Searches ALL accounts unless specified. " +
        "Pass simple keywords (e.g. 'lizard island'). " +
        "Supports: from:, to:, subject:, is:unread, has:attachment, after:2026/01/01.",
      parameters: {
        type: S.OBJECT,
        properties: {
          query: { type: S.STRING, description: "Gmail search query" },
          account: { type: S.STRING, description: "Email account (optional)" },
          max_results: { type: S.INTEGER, description: "Max results (default 10)" },
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
          to: { type: S.STRING, description: "Recipient email" },
          subject: { type: S.STRING, description: "Subject" },
          body: { type: S.STRING, description: "Body text" },
          account: { type: S.STRING, description: "Send from (optional)" },
          thread_id: { type: S.STRING, description: "Thread ID for replies (optional)" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "calendar_list",
      description: "List upcoming calendar events. Shows ALL accounts unless specified.",
      parameters: {
        type: S.OBJECT,
        properties: {
          days_ahead: { type: S.INTEGER, description: "Days ahead (default 1)" },
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
          start_time: { type: S.STRING, description: "Start (ISO 8601)" },
          end_time: { type: S.STRING, description: "End (ISO 8601)" },
          description: { type: S.STRING, description: "Description (optional)" },
          attendees: { type: S.ARRAY, description: "Attendee emails", items: { type: S.STRING } },
          account: { type: S.STRING, description: "Account (optional)" },
        },
        required: ["summary", "start_time", "end_time"],
      },
    },
  ] as FunctionDeclaration[],

  createHandlers(ctx: ToolContext) {
    return {
      gmail_search: async (args: Record<string, unknown>) => {
        const hint = args["account"] as string | undefined;
        const query = args["query"] as string;
        const max = (args["max_results"] as number) ?? 10;

        if (hint) {
          const acct = resolveAccount(ctx.googleAccounts, hint);
          return gmailSearch(acct, query, max);
        }
        const results = await Promise.all(
          ctx.googleAccounts.map(async (acct) => {
            const r = await gmailSearch(acct, query, max);
            return `--- ${acct.email} ---\n${r}`;
          }),
        );
        return results.join("\n\n");
      },

      gmail_read: async (args: Record<string, unknown>) => {
        const hint = args["account"] as string | undefined;
        const messageId = args["message_id"] as string;

        if (hint) {
          const acct = resolveAccount(ctx.googleAccounts, hint);
          return gmailRead(acct, messageId);
        }
        for (const acct of ctx.googleAccounts) {
          try {
            return await gmailRead(acct, messageId);
          } catch {
            continue;
          }
        }
        return `Could not read message ${messageId} from any account.`;
      },

      gmail_send: (args: Record<string, unknown>) => {
        const acct = resolveAccount(ctx.googleAccounts, args["account"] as string | undefined);
        return gmailSend(
          acct,
          args["to"] as string,
          args["subject"] as string,
          args["body"] as string,
          args["thread_id"] as string | undefined,
        );
      },

      calendar_list: async (args: Record<string, unknown>) => {
        const hint = args["account"] as string | undefined;
        const days = (args["days_ahead"] as number) ?? 1;

        if (hint) {
          const acct = resolveAccount(ctx.googleAccounts, hint);
          return calendarList(acct, days);
        }
        const results = await Promise.all(
          ctx.googleAccounts.map(async (acct) => {
            const r = await calendarList(acct, days);
            return `--- ${acct.email} ---\n${r}`;
          }),
        );
        return results.join("\n\n");
      },

      calendar_create: (args: Record<string, unknown>) => {
        const acct = resolveAccount(ctx.googleAccounts, args["account"] as string | undefined);
        return calendarCreate(
          acct,
          args["summary"] as string,
          args["start_time"] as string,
          args["end_time"] as string,
          args["description"] as string | undefined,
          args["attendees"] as string[] | undefined,
        );
      },
    };
  },
};
