import cron from "node-cron";
import type { Config } from "../config.js";
import type { AgentDeps } from "../agent/loop.js";
import { agentLoop } from "../agent/loop.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function startHeartbeat(
  config: Config,
  agentDeps: AgentDeps,
  sendToTelegram: (text: string) => Promise<void>
): void {
  const heartbeatPath = resolve(config.workspaceDir, "HEARTBEAT.md");

  // Heartbeat cron
  const interval = config.heartbeatIntervalMinutes;
  const cronExpr = `*/${interval} * * * *`;

  cron.schedule(cronExpr, async () => {
    if (!isActiveHours(config.activeHours)) {
      console.log("[heartbeat] Outside active hours, skipping");
      return;
    }

    const checklist = existsSync(heartbeatPath)
      ? readFileSync(heartbeatPath, "utf-8")
      : "";

    if (!checklist.trim()) {
      console.log("[heartbeat] No HEARTBEAT.md or empty, skipping");
      return;
    }

    console.log("[heartbeat] Running check...");
    const prompt = `HEARTBEAT CHECK. Review this checklist and take action:\n\n${checklist}\n\n` +
      "If nothing needs attention, respond with exactly 'HEARTBEAT_OK' and nothing else.";

    try {
      const response = await agentLoop(agentDeps, prompt, config.models.fast);

      if (response.trim().startsWith("HEARTBEAT_OK") && response.length < 300) {
        console.log("[heartbeat] OK — suppressed");
        return;
      }

      console.log("[heartbeat] Alert detected, sending to Telegram");
      await sendToTelegram(response);
    } catch (e) {
      const err = e as Error;
      console.log(`[heartbeat] Error: ${err.message}`);
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
        "🔴 CRITICAL — items needing immediate action (patient alerts, deadlines, urgent requests)\n" +
        "🟡 ACTION — items needing attention this week (documents to review, replies needed)\n" +
        "📅 TODAY — calendar events with times\n" +
        "🔵 FYI — informational updates (team updates, newsletters)\n\n" +
        "For each item: one line with sender, subject, and what to do.\n" +
        "Skip spam, promotions, and marketing. Be concise — this goes to Telegram.\n" +
        "If nothing important, just say 'All clear — no urgent items.'";

      try {
        const response = await agentLoop(agentDeps, prompt, config.models.smart);
        if (response.trim() === "All clear — no urgent items.") {
          console.log("[briefing] All clear — suppressed");
          return;
        }
        await sendToTelegram(response);
      } catch (e) {
        const err = e as Error;
        console.log(`[briefing] Error: ${err.message}`);
      }
    });

    console.log(`[briefing] Scheduled: ${config.morningBriefingCron}`);
  }
}

function isActiveHours(hours: { start: number; end: number }): boolean {
  const now = new Date();
  const hour = now.getHours();
  return hour >= hours.start && hour < hours.end;
}
