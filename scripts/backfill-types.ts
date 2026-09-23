import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const config = loadConfig(ROOT_DIR);
const db = openDatabase(config.dataDir);

const dirs = [
  "/Users/cb/Documents/Obsidian Vault/people",
  "/Users/cb/Documents/Obsidian Vault/people-unverified",
];

let updated = 0;
for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const content = readFileSync(join(dir, file), "utf-8");
    const yaml = content.split("---")[1];
    if (!yaml) continue;

    const typeMatch = yaml.match(/^type:\s*"?([^"\n]+)"?/m);
    const emailMatch = yaml.match(/^email:\s*"?([^"\n]+)"?/m);
    if (!typeMatch || !emailMatch) continue;

    const type = typeMatch[1]!.trim();
    const email = emailMatch[1]!.trim();

    const result = db.prepare(
      `UPDATE people SET type = ? WHERE email = ? AND (type IS NULL OR type = '')`
    ).run(type, email);
    if (result.changes > 0) updated++;
  }
}

console.log(`Backfilled type for ${updated} people`);

const types = db.prepare(
  "SELECT type, COUNT(*) as n FROM people WHERE type IS NOT NULL GROUP BY type ORDER BY n DESC"
).all() as { type: string; n: number }[];
for (const t of types) console.log(`  ${t.type}: ${t.n}`);

db.close();
