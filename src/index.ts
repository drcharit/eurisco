import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { MarkdownMemory } from "./memory/markdown.js";
import { createBot } from "./channels/telegram.js";
import { createGoogleAccounts, findAccount } from "./services/google-auth.js";
import { initHistory } from "./agent/history.js";
import { initFlushCallback, type AgentDeps } from "./agent/loop.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { SkillRegistry } from "./skills/registry.js";
import { travelSkill } from "./skills/travel.js";
import { commsSkill } from "./skills/comms.js";
import { knowledgeSkill } from "./skills/knowledge.js";
import { systemSkill } from "./skills/system.js";
import { climateSkill } from "./skills/climate.js";
import { trainingSkill } from "./skills/training.js";
import { startACScheduler } from "./services/ac-scheduler.js";
import { acPowerDraw } from "./services/ac.js";
import { startStravaSync } from "./services/strava.js";
import { startIngestServer } from "./services/ingest.js";
import { createSleepHandler } from "./services/sleep.js";
import { createTemperatureHandler, startTemperaturePoller, startPowerLogger } from "./services/temperature.js";
import { initSleepSheet } from "./services/sleep-sheet.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");

// Catch unhandled rejections — log instead of crashing
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
});

function main(): void {
  const t0 = performance.now();
  const config = loadConfig(ROOT_DIR);
  const db = openDatabase(config.dataDir);
  const memory = new MarkdownMemory(config.workspaceDir);
  const profilesDir = resolve(config.workspaceDir, "people", "profiles");
  const googleAccounts = createGoogleAccounts(config);

  initHistory(config.dataDir);

  console.log(`Google accounts: ${googleAccounts.map((a) => a.email).join(", ") || "none"}`);

  // Build skill registry
  const registry = new SkillRegistry();
  const skills = [travelSkill, commsSkill, knowledgeSkill, systemSkill, climateSkill, trainingSkill];
  for (const s of skills) registry.register(s);
  console.log(`Skills: ${registry.count}`);

  const agentDeps: AgentDeps = {
    config,
    memory,
    registry,
    toolCtx: {
      db, memory, profilesDir, googleAccounts,
      amadeusClientId: config.amadeusClientId,
      amadeusClientSecret: config.amadeusClientSecret,
      acCredentials: {
        irBlasterIp: config.tuyaIrBlasterIp,
        irBlasterKey: config.tuyaIrBlasterKey,
        cloudAccessId: config.tuyaCloudAccessId,
        cloudAccessSecret: config.tuyaCloudAccessSecret,
        irBlasterDeviceId: config.tuyaIrDeviceId,
        acSubDeviceId: config.tuyaAcDeviceId,
        plugIp: config.tuyaPlugIp,
        plugKey: config.tuyaPlugKey,
        plugDeviceId: config.tuyaPlugDeviceId,
      },
    },
  };

  initFlushCallback(agentDeps);

  const bot = createBot(config, agentDeps);

  const sendToTelegram = async (text: string): Promise<void> => {
    try {
      await bot.api.sendMessage(config.telegramOwnerId, text);
    } catch (e) {
      console.log(`[telegram] Send failed: ${(e as Error).message}`);
    }
  };

  // Start all services — none depend on each other
  startHeartbeat(config, agentDeps, sendToTelegram);

  if (config.tuyaIrBlasterIp || config.tuyaCloudAccessId) {
    startACScheduler(ROOT_DIR, agentDeps.toolCtx.acCredentials, sendToTelegram);
  }

  const personalAccount = findAccount(googleAccounts, "personal");

  if (config.stravaClientId && config.stravaRefreshToken) {
    startStravaSync(config, db, personalAccount, sendToTelegram);
  }

  if (personalAccount) {
    initSleepSheet(personalAccount, config.workspaceDir);
  }

  startIngestServer(3141, [
    createSleepHandler(config.workspaceDir),
    createTemperatureHandler(config.workspaceDir),
  ], sendToTelegram);

  // Poll ESP8266 for temperature every 60s
  const espTempUrl = process.env["ESP32_TEMPERATURE_URL"];
  if (espTempUrl) {
    startTemperaturePoller(espTempUrl, config.workspaceDir, 60_000);
  }

  // Log AC power every 5 min, 24/7
  if (config.tuyaCloudAccessId || config.tuyaIrBlasterIp) {
    startPowerLogger(() => acPowerDraw(agentDeps.toolCtx.acCredentials), config.workspaceDir);
  }

  process.on("SIGINT", () => shutdown(db));
  process.on("SIGTERM", () => shutdown(db));

  console.log(`Init: ${(performance.now() - t0).toFixed(0)}ms`);

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
