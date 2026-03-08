import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface GoogleAccountConfig {
  name: string;
  email: string;
  refreshToken: string;
}

export interface Config {
  geminiApiKey: string;
  telegramBotToken: string;
  telegramOwnerId: number;
  googleClientId: string;
  googleClientSecret: string;
  googleAccounts: GoogleAccountConfig[];
  amadeusClientId: string;
  amadeusClientSecret: string;
  activeHours: { start: number; end: number };
  heartbeatIntervalMinutes: number;
  morningBriefingCron: string;
  maxAgentIterations: number;
  maxRetries: number;
  models: { fast: string; smart: string };
  followUpThresholds: { hotDays: number; activeDays: number; coldDays: number };
  dataDir: string;
  workspaceDir: string;
}

function loadGoogleAccounts(): GoogleAccountConfig[] {
  const accounts: GoogleAccountConfig[] = [];
  for (let i = 1; i <= 5; i++) {
    const email = process.env[`GOOGLE_ACCOUNT_${i}_EMAIL`];
    const token = process.env[`GOOGLE_ACCOUNT_${i}_REFRESH_TOKEN`];
    const name = process.env[`GOOGLE_ACCOUNT_${i}_NAME`] ?? email ?? "";
    if (email && token) {
      accounts.push({ name, email, refreshToken: token });
    }
  }
  return accounts;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export function loadConfig(rootDir: string): Config {
  const envPath = resolve(rootDir, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
  }

  const kitJsonPath = resolve(rootDir, "config", "kit.json");
  const kitJson = JSON.parse(readFileSync(kitJsonPath, "utf-8"));

  return {
    geminiApiKey: requireEnv("GEMINI_API_KEY"),
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    telegramOwnerId: Number(requireEnv("TELEGRAM_OWNER_ID")),
    googleClientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
    googleClientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
    googleAccounts: loadGoogleAccounts(),
    amadeusClientId: process.env["AMADEUS_CLIENT_ID"] ?? "",
    amadeusClientSecret: process.env["AMADEUS_CLIENT_SECRET"] ?? "",
    activeHours: kitJson.activeHours,
    heartbeatIntervalMinutes: kitJson.heartbeatIntervalMinutes,
    morningBriefingCron: kitJson.morningBriefingCron,
    maxAgentIterations: kitJson.maxAgentIterations,
    maxRetries: kitJson.maxRetries,
    models: kitJson.models,
    followUpThresholds: kitJson.followUpThresholds,
    dataDir: resolve(rootDir, "data"),
    workspaceDir: resolve(rootDir, "workspace"),
  };
}
