/**
 * One-time script: extract Tuya device local keys from the cloud API.
 *
 * Run once, copy the output into .env, then never use the cloud again.
 *
 *   TUYA_ACCESS_ID=xxx TUYA_ACCESS_SECRET=xxx npx tsx scripts/tuya-extract-keys.ts
 *
 * Requires: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_IR_DEVICE_ID, TUYA_PLUG_DEVICE_ID
 * from environment or .env file.
 */

import * as crypto from "node:crypto";
import * as https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const BASE_HOST = "openapi.tuyain.com";

// Load .env if present
const envPath = resolve(import.meta.dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const ACCESS_ID = process.env["TUYA_ACCESS_ID"] ?? "";
const ACCESS_SECRET = process.env["TUYA_ACCESS_SECRET"] ?? "";
const DEVICE_IDS = [
  { label: "IR Blaster", id: process.env["TUYA_IR_DEVICE_ID"] ?? "" },
  { label: "Smart Plug", id: process.env["TUYA_PLUG_DEVICE_ID"] ?? "" },
];

if (!ACCESS_ID || !ACCESS_SECRET) {
  console.error("Missing TUYA_ACCESS_ID or TUYA_ACCESS_SECRET");
  process.exit(1);
}

function hmac(key: string, msg: string): string {
  return crypto.createHmac("sha256", key).update(msg).digest("hex").toUpperCase();
}

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function httpGet(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: BASE_HOST, path, method: "GET", headers: { "Content-Type": "application/json", ...headers } },
      (res) => { let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => resolve(d)); },
    );
    req.on("error", reject);
    req.end();
  });
}

async function getToken(): Promise<string> {
  const t = Date.now().toString();
  const path = "/v1.0/token?grant_type=1";
  const sign = hmac(ACCESS_SECRET, ACCESS_ID + t + `GET\n${sha256("")}\n\n${path}`);
  const raw = await httpGet(path, { client_id: ACCESS_ID, sign, t, sign_method: "HMAC-SHA256" });
  const data = JSON.parse(raw) as { success: boolean; result?: { access_token: string }; msg?: string };
  if (!data.success) throw new Error(`Token failed: ${data.msg}`);
  return data.result!.access_token;
}

async function getDeviceInfo(token: string, deviceId: string): Promise<{ localKey: string; ip: string; name: string }> {
  const t = Date.now().toString();
  const path = `/v1.0/iot-03/devices/${deviceId}`;
  const sign = hmac(ACCESS_SECRET, ACCESS_ID + token + t + `GET\n${sha256("")}\n\n${path}`);
  const raw = await httpGet(path, {
    client_id: ACCESS_ID, access_token: token, sign, t, sign_method: "HMAC-SHA256",
  });
  const data = JSON.parse(raw) as {
    success: boolean;
    result?: { local_key: string; ip: string; name: string };
    msg?: string;
  };
  if (!data.success) throw new Error(`Device ${deviceId}: ${data.msg}`);
  return { localKey: data.result!.local_key, ip: data.result!.ip, name: data.result!.name };
}

async function main(): Promise<void> {
  const token = await getToken();
  console.log("Token obtained.\n");

  for (const { label, id } of DEVICE_IDS) {
    if (!id) { console.log(`# ${label}: no device ID configured, skipping`); continue; }
    try {
      const info = await getDeviceInfo(token, id);
      console.log(`# ${label}: ${info.name}`);
      console.log(`#   Device ID: ${id}`);
      console.log(`#   Local Key: ${info.localKey}`);
      console.log(`#   IP:        ${info.ip}`);
      console.log();
    } catch (e) {
      console.error(`# ${label} (${id}): ${(e as Error).message}`);
    }
  }

  console.log("# Add these to your .env:");
  console.log("# TUYA_IR_BLASTER_IP=<ip from above>");
  console.log("# TUYA_IR_BLASTER_KEY=<local key from above>");
  console.log("# TUYA_PLUG_IP=<ip from above>");
  console.log("# TUYA_PLUG_KEY=<local key from above>");
}

main().catch((e) => { console.error(e); process.exit(1); });
