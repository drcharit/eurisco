/**
 * Build People Knowledge Base
 *
 * Scans email history, identifies real people you've corresponded with,
 * verifies them on the web, and creates rich Obsidian profiles.
 *
 * Usage:
 *   npx tsx src/people/build-kb.ts              # Full run (last 2 years)
 *   npx tsx src/people/build-kb.ts --scan-only  # Phase 1 only (identify candidates)
 *   npx tsx src/people/build-kb.ts --stats      # Show DB stats
 */

import { resolve } from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { createGoogleAccounts } from "../services/google-auth.js";
import { scanAndFilter, processPerson } from "./extract.js";

const ROOT_DIR = resolve(import.meta.dirname, "../..");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scanOnly = args.includes("--scan-only");
  const showStats = args.includes("--stats");

  const t0 = performance.now();
  const config = loadConfig(ROOT_DIR);
  const db = openDatabase(config.dataDir);
  const accounts = createGoogleAccounts(config);
  const ownerEmails = accounts.map((a) => a.email);

  if (accounts.length === 0) {
    console.error("No Google accounts configured.");
    process.exit(1);
  }

  if (showStats) {
    printStats(db);
    db.close();
    return;
  }

  console.log(`Accounts: ${ownerEmails.join(", ")}`);
  const ownerDomain = ownerEmails[0]?.split("@")[1] ?? "unknown";
  console.log(`Excluding: @${ownerDomain} (internal)`);
  console.log(`Filter: bidirectional only (sent + received)`);

  // Phase 1: Scan last 2 years
  const afterDate = "2024/03/08";
  console.log(`\n=== Phase 1: Scan emails after ${afterDate} ===`);

  const candidates = await scanAndFilter(accounts, ownerEmails, afterDate, 10000);

  // Sort by total emails descending (most active contacts first)
  const sorted = Array.from(candidates.entries())
    .sort((a, b) => b[1].totalEmails - a[1].totalEmails);

  console.log(`\n=== Candidates: ${sorted.length} bidirectional external contacts ===`);
  console.log("Top 20:");
  for (const [, c] of sorted.slice(0, 20)) {
    console.log(`  ${c.name} <${c.email}> — ${c.totalEmails} emails (${c.sentTo}↑ ${c.receivedFrom}↓) [${c.firstDate} → ${c.lastDate}]`);
  }

  if (scanOnly) {
    console.log(`\nFull list: ${sorted.length} candidates`);
    for (const [, c] of sorted) {
      console.log(`  ${c.name} <${c.email}> — ${c.totalEmails} emails`);
    }
    db.close();
    return;
  }

  // Phase 2-5: Process each person
  const genai = new GoogleGenerativeAI(config.geminiApiKey);
  const model = genai.getGenerativeModel({ model: config.models.fast });

  let processed = 0;
  let verified = 0;
  let unverified = 0;
  let skipped = 0;

  console.log(`\n=== Phase 2-5: Processing ${sorted.length} people ===`);

  for (const [, candidate] of sorted) {
    try {
      const profile = await processPerson(accounts, candidate, candidates, model, db);
      if (profile) {
        processed++;
        if (profile.verified) verified++;
        else unverified++;
      } else {
        skipped++;
      }

      // Progress update every 10
      if ((processed + skipped) % 10 === 0) {
        console.log(`\n--- Progress: ${processed} processed, ${skipped} skipped, ${verified} verified, ${unverified} unverified ---`);
      }
    } catch (e) {
      const err = e as Error;
      console.log(`[error] ${candidate.email}: ${err.message.slice(0, 100)}`);
      skipped++;
    }
  }

  // Final stats
  console.log("\n=== Complete ===");
  console.log(`Processed: ${processed}`);
  console.log(`Verified:  ${verified} → Obsidian Vault/people/`);
  console.log(`Unverified: ${unverified} → Obsidian Vault/people-unverified/`);
  console.log(`Skipped:   ${skipped} (not a person / no data)`);

  printStats(db);
  db.close();
  console.log(`\nTotal time: ${((performance.now() - t0) / 1000 / 60).toFixed(1)} minutes`);
}

function printStats(db: ReturnType<typeof openDatabase>): void {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;

  console.log("\n--- Knowledge Base Stats ---");
  console.log(`People:      ${count("people")}`);
  console.log(`Emails:      ${count("people_emails")}`);
  console.log(`Topics:      ${count("topics")}`);
  console.log(`Connections: ${count("connections")}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
