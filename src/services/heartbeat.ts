import { GoogleGenerativeAI } from "@google/generative-ai";
import cron from "node-cron";
import type { Config } from "../config.js";
import type { AgentDeps } from "../agent/loop.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Stateless Gemini call for heartbeat/briefing.
 * Does NOT touch conversation history — isolated from user chat.
 * Has tool access for gmail_search, calendar_list, people_search.
 */
async function statelessCall(
  deps: AgentDeps,
  prompt: string,
  model: string,
): Promise<string> {
  const genai = new GoogleGenerativeAI(deps.config.geminiApiKey);
  const genModel = genai.getGenerativeModel({
    model,
    tools: [{ functionDeclarations: deps.registry.getToolDeclarations() }],
  });
  const handlers = deps.registry.createHandlers(deps.toolCtx);
  const chat = genModel.startChat();

  let response = await chat.sendMessage([{ text: prompt }]);
  const MAX_ITER = 10;

  for (let i = 0; i < MAX_ITER; i++) {
    const parts = response.response.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) break;

    const fnCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ name: p.functionCall!.name, args: (p.functionCall!.args ?? {}) as Record<string, unknown> }));

    if (fnCalls.length === 0) {
      return parts.filter((p) => p.text).map((p) => p.text).join("") || "";
    }

    // Execute tools in parallel
    const toolNames = fnCalls.map((c) => c.name).join(",");
    const t0 = performance.now();
    const fnResponses = await Promise.all(
      fnCalls.map(async (call) => {
        const handler = handlers[call.name];
        let result: string;
        if (!handler) { result = `Unknown tool: ${call.name}`; }
        else { try { result = await handler(call.args); } catch (e) { result = `Error: ${(e as Error).message}`; } }
        return { functionResponse: { name: call.name, response: { result } } };
      }),
    );
    console.log(`[${toolNames}]: ${(performance.now() - t0).toFixed(0)}ms`);

    response = await chat.sendMessage(fnResponses);
  }

  return "";
}

export function startHeartbeat(
  config: Config,
  agentDeps: AgentDeps,
  sendToTelegram: (text: string) => Promise<void>,
): void {
  const heartbeatPath = resolve(config.workspaceDir, "HEARTBEAT.md");
  let heartbeatRunning = false;

  const interval = config.heartbeatIntervalMinutes;
  const cronExpr = `*/${interval} * * * *`;

  cron.schedule(cronExpr, async () => {
    if (!isActiveHours(config.activeHours)) return;
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const checklist = existsSync(heartbeatPath) ? readFileSync(heartbeatPath, "utf-8") : "";
      if (!checklist.trim()) return;

      console.log("[heartbeat] Running check...");
      const prompt = `HEARTBEAT CHECK. Review this checklist and take action:\n\n${checklist}\n\n` +
        "IMPORTANT: Only alert for genuinely URGENT items — patient emergencies, security breaches, " +
        "system outages, or deadlines within 2 hours. Routine unread emails, newsletters, and " +
        "marketing are NOT alerts. If nothing is genuinely urgent, respond with exactly " +
        "'HEARTBEAT_OK' and nothing else. Do NOT notify for normal unread emails.";

      const response = await statelessCall(agentDeps, prompt, config.models.fast);

      if (response.includes("HEARTBEAT_OK") || response.trim().length < 50) {
        console.log("[heartbeat] OK — suppressed");
        return;
      }
      console.log("[heartbeat] Alert, sending to Telegram");
      await sendToTelegram(response);
    } catch (e) {
      console.log(`[heartbeat] Error: ${(e as Error).message}`);
    } finally {
      heartbeatRunning = false;
    }
  });

  console.log(`[heartbeat] Scheduled every ${interval}m during ${config.activeHours.start}-${config.activeHours.end}h`);

  // Morning briefing
  if (config.morningBriefingCron) {
    cron.schedule(config.morningBriefingCron, async () => {
      console.log("[briefing] Running morning briefing...");
      const prompt =
        "Morning briefing. Follow these steps:\n\n" +
        "1. Search ALL email accounts for unread messages from the last 24 hours.\n" +
        "2. Check today's calendar events across all accounts.\n" +
        "3. Check people_search for any follow-ups due.\n\n" +
        "Format your response as a Telegram-friendly digest:\n\n" +
        "CRITICAL — items needing immediate action\n" +
        "ACTION — items needing attention this week\n" +
        "TODAY — calendar events with times\n" +
        "FYI — informational updates\n\n" +
        "For each item: one line with sender, subject, and what to do.\n" +
        "Skip spam, promotions, and marketing. Be concise — this goes to Telegram.\n" +
        "If nothing important, just say 'All clear — no urgent items.'";

      try {
        const response = await statelessCall(agentDeps, prompt, config.models.smart);
        if (response.includes("All clear") || response.trim().length < 50) {
          console.log("[briefing] All clear — suppressed");
          return;
        }
        await sendToTelegram(response);
      } catch (e) {
        console.log(`[briefing] Error: ${(e as Error).message}`);
      }
    });

    console.log(`[briefing] Scheduled: ${config.morningBriefingCron}`);
  }
}

function isActiveHours(hours: { start: number; end: number }): boolean {
  const hour = new Date().getHours();
  return hour >= hours.start && hour < hours.end;
}
