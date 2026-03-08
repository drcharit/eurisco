import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { MarkdownMemory } from "./memory/markdown.js";
import { createBot } from "./channels/telegram.js";
import { createGoogleAccounts } from "./services/google-auth.js";
import { initHistory } from "./agent/history.js";
import { initFlushCallback, type AgentDeps } from "./agent/loop.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { SkillRegistry } from "./skills/registry.js";
import { travelSkill } from "./skills/travel.js";
import { commsSkill } from "./skills/comms.js";
import { knowledgeSkill } from "./skills/knowledge.js";
import { systemSkill } from "./skills/system.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");

function main(): void {
  const config = loadConfig(ROOT_DIR);
  const db = openDatabase(config.dataDir);
  const memory = new MarkdownMemory(config.workspaceDir);
  const profilesDir = resolve(config.workspaceDir, "people", "profiles");
  const googleAccounts = createGoogleAccounts(config);

  // Init persistent history
  initHistory(config.dataDir);

  console.log(`Google accounts: ${googleAccounts.map((a) => a.email).join(", ") || "none configured"}`);

  // Build skill registry
  const registry = new SkillRegistry();
  registry.register(travelSkill);
  registry.register(commsSkill);
  registry.register(knowledgeSkill);
  registry.register(systemSkill);
  console.log(`Skills loaded: ${registry.count}`);

  const agentDeps: AgentDeps = {
    config,
    memory,
    registry,
    toolCtx: {
      db, memory, profilesDir, googleAccounts,
      amadeusClientId: config.amadeusClientId,
      amadeusClientSecret: config.amadeusClientSecret,
    },
  };

  // Init pre-compaction memory flush
  initFlushCallback(agentDeps);

  const bot = createBot(config, agentDeps);

  // Start heartbeat & morning briefing
  const sendToTelegram = async (text: string): Promise<void> => {
    try {
      await bot.api.sendMessage(config.telegramOwnerId, text);
    } catch (e) {
      const err = e as Error;
      console.log(`[telegram] Failed to send proactive message: ${err.message}`);
    }
  };

  startHeartbeat(config, agentDeps, sendToTelegram);

  process.on("SIGINT", () => shutdown(db));
  process.on("SIGTERM", () => shutdown(db));

  console.log("Eurisco starting...");
  bot.start({
    onStart: () => console.log("Eurisco is online. Kit bot active."),
  });
}

function shutdown(db: { close: () => void }): void {
  console.log("Shutting down...");
  db.close();
  process.exit(0);
}

main();
