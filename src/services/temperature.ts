/**
 * Temperature + humidity from ESP32 sensor.
 *
 * Two ingestion modes (both can run simultaneously):
 *   1. Push: ESP32 POSTs to /temperature on the ingest server
 *   2. Pull: RPi polls http://{esp32}/temperature every 30s
 *
 * Pull mode works around router WiFi↔wired isolation
 * (RPi can reach ESP32 but ESP32 can't reach RPi).
 *
 * Latest reading is kept in memory for live access.
 * Daily log saved to workspace/climate/YYYY-MM-DD.log.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IngestHandler, IngestResult } from "./ingest.js";

interface Reading {
  temp: number;
  humidity: number | null;
  time: Date;
}

let latest: Reading | null = null;
let climateDir = "";

/** Get the most recent temperature reading, or null if none received yet. */
export function getLatestTemperature(): Reading | null {
  return latest;
}

/** Age of latest reading in seconds, or Infinity if no reading. */
export function temperatureAge(): number {
  if (!latest) return Infinity;
  return (Date.now() - latest.time.getTime()) / 1000;
}

function recordReading(temp: number, humidity: number | null): void {
  const now = new Date();
  latest = { temp, humidity, time: now };

  if (!climateDir) return;
  const date = now.toISOString().slice(0, 10);
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const logPath = resolve(climateDir, `${date}.log`);

  const hStr = humidity !== null ? `${humidity}%` : "—";
  appendFileSync(logPath, `${time} | ${temp}°C | ${hStr}\n`);

  console.log(`[temperature] ${temp}°C ${hStr} RH`);
}

// ── Push mode: ingest handler ──────────────────────────────────────────────

export function createTemperatureHandler(workspaceDir: string): IngestHandler {
  climateDir = resolve(workspaceDir, "climate");
  if (!existsSync(climateDir)) mkdirSync(climateDir, { recursive: true });

  return {
    path: "temperature",
    async handle(body: string): Promise<IngestResult> {
      const data = JSON.parse(body);
      const { temp, humidity } = data;

      if (typeof temp !== "number") {
        return { response: { ok: false, error: "Missing or invalid 'temp' field" } };
      }

      recordReading(temp, typeof humidity === "number" ? humidity : null);
      return { response: { ok: true, temp, humidity, time: new Date().toISOString() } };
    },
  };
}

// ── Pull mode: poll ESP32 ──────────────────────────────────────────────────

export function startTemperaturePoller(
  espUrl: string,
  workspaceDir: string,
  intervalMs = 30_000,
): void {
  climateDir = resolve(workspaceDir, "climate");
  if (!existsSync(climateDir)) mkdirSync(climateDir, { recursive: true });

  async function poll(): Promise<void> {
    try {
      const res = await fetch(espUrl, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return;
      const data = (await res.json()) as { temp?: number; humidity?: number };
      if (typeof data.temp !== "number") return;
      recordReading(data.temp, typeof data.humidity === "number" ? data.humidity : null);
    } catch (e) {
      // Silent — ESP32 may be offline or rebooting
      console.log(`[temperature] poll failed: ${(e as Error).message}`);
    }
  }

  poll();
  setInterval(poll, intervalMs);
  console.log(`[temperature] Polling ${espUrl} every ${intervalMs / 1000}s`);
}

// ── Power monitoring (24/7) ────────────────────────────────────────────────

export function startPowerLogger(
  acPowerDraw: () => Promise<number>,
  workspaceDir: string,
  intervalMs = 300_000, // every 5 min
): void {
  const dir = resolve(workspaceDir, "climate");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  async function logPower(): Promise<void> {
    try {
      const watts = await acPowerDraw();
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const logPath = resolve(dir, `power-${date}.log`);
      appendFileSync(logPath, `${time} | ${watts.toFixed(0)}W\n`);
    } catch {
      // silent
    }
  }

  logPower();
  setInterval(logPower, intervalMs);
  console.log(`[power] Logging AC power every ${intervalMs / 1000}s`);
}

/** Read temperature log for a given date (YYYY-MM-DD). */
export function readTemperatureLog(workspaceDir: string, date: string): string | null {
  const path = resolve(workspaceDir, "climate", `${date}.log`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** Read power log for a given date (YYYY-MM-DD). */
export function readPowerLog(workspaceDir: string, date: string): string | null {
  const path = resolve(workspaceDir, "climate", `power-${date}.log`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
