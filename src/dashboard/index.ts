/**
 * People CRM Dashboard
 *
 * Local web server for viewing and managing your personal CRM.
 *
 * Usage:
 *   npx tsx src/dashboard/index.ts
 *   npx tsx src/dashboard/index.ts --port 8080
 */

import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { createGoogleAccounts } from "../services/google-auth.js";
import { startDashboard } from "./server.js";

const ROOT_DIR = resolve(import.meta.dirname, "../..");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const port = portIdx !== -1 ? Number(args[portIdx + 1]) : 3000;

const config = loadConfig(ROOT_DIR);
const db = openDatabase(config.dataDir);
const accounts = createGoogleAccounts(config);

console.log(`Accounts: ${accounts.map((a) => a.email).join(", ")}`);
console.log(`Database: ${config.dataDir}/eurisco.db`);

startDashboard(db, accounts, port);
