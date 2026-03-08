import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dirname, "..", "test-tmp-config");

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(resolve(TEST_DIR, "config"), { recursive: true });
    writeFileSync(
      resolve(TEST_DIR, ".env"),
      [
        "GEMINI_API_KEY=test-gemini-key",
        "TELEGRAM_BOT_TOKEN=test-bot-token",
        "TELEGRAM_OWNER_ID=12345",
      ].join("\n")
    );
    writeFileSync(
      resolve(TEST_DIR, "config", "kit.json"),
      JSON.stringify({
        activeHours: { start: 6, end: 23 },
        heartbeatIntervalMinutes: 60,
        morningBriefingCron: "57 5 * * *",
        maxAgentIterations: 25,
        maxRetries: 3,
        models: { fast: "gemini-2.0-flash", smart: "gemini-2.5-pro" },
        followUpThresholds: { hotDays: 14, activeDays: 30, coldDays: 90 },
      })
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env["GEMINI_API_KEY"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["TELEGRAM_OWNER_ID"];
  });

  it("loads env vars and kit.json", () => {
    const config = loadConfig(TEST_DIR);
    assert.equal(config.geminiApiKey, "test-gemini-key");
    assert.equal(config.telegramBotToken, "test-bot-token");
    assert.equal(config.telegramOwnerId, 12345);
    assert.equal(config.maxAgentIterations, 25);
    assert.equal(config.models.fast, "gemini-2.0-flash");
  });

  it("throws on missing required env var", () => {
    writeFileSync(resolve(TEST_DIR, ".env"), "GEMINI_API_KEY=key-only\n");
    assert.throws(
      () => loadConfig(TEST_DIR),
      /Missing required env var: TELEGRAM_BOT_TOKEN/
    );
  });
});
