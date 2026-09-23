/**
 * AC session logger.
 *
 * Logs to workspace/ac/YYYY-MM-DD.log (one file per day).
 * Tracks ALL power readings every 5 min (compressor + standby).
 * Computes energy (kWh) and cost (INR) per session using trapezoidal integration.
 *
 * Log format (tab-separated):
 *   HH:MM:SS  EVENT  details...
 *
 * Session summary appended when AC turns off:
 *   HH:MM:SS  SESSION  duration=6h30m  energy=8.5kWh  cost=INR 69.3  duty=52%
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// BESCOM Bangalore slab rates (2024-25, domestic)
// 0–50 units: ₹4.10, 51–100: ₹5.55, 101–200: ₹7.10, >200: ₹8.15
// For AC usage, most households are in the >200 slab.
const INR_PER_KWH = 8.15;

let logDir = "";

/** Running session tracker */
let sessionStart: Date | null = null;
let sessionSamples: Array<{ time: Date; watts: number }> = [];

export function initACLog(workspaceDir: string): void {
  logDir = resolve(workspaceDir, "ac");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
}

function logPath(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  return resolve(logDir, `${date}.log`);
}

function ts(): string {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

export function acLog(event: string, details: string): void {
  if (!logDir) return;
  const line = `${ts()}\t${event}\t${details}\n`;
  try {
    appendFileSync(logPath(), line);
  } catch {
    // silently ignore write errors
  }
  console.log(`[ac-log] ${event}: ${details}`);
}

export function acLogSessionStart(): void {
  sessionStart = new Date();
  sessionSamples = [];
  acLog("START", "AC session started");
}

/** Log every power reading — compressor on AND standby. */
export function acLogSample(watts: number): void {
  if (!sessionStart) return;
  sessionSamples.push({ time: new Date(), watts });
  const compressor = watts > 50 ? "compressor" : "standby";
  acLog("SAMPLE", `${watts.toFixed(0)}W (${compressor})`);
}

export function acLogSessionEnd(): void {
  if (!sessionStart) {
    acLog("END", "AC session ended (no active session)");
    return;
  }

  if (sessionSamples.length === 0) {
    const end = new Date();
    const durStr = formatDuration(end.getTime() - sessionStart.getTime());
    acLog("SESSION", `duration=${durStr}  energy=0kWh  cost=INR 0  duty=0%`);
    acLog("END", "AC session ended (no samples)");
    sessionStart = null;
    sessionSamples = [];
    return;
  }

  const end = new Date();
  const durationMs = end.getTime() - sessionStart.getTime();

  // Compute energy: trapezoidal integration over ALL samples (including standby)
  let energyWh = 0;
  let compressorMs = 0;
  for (let i = 0; i < sessionSamples.length; i++) {
    const sample = sessionSamples[i]!;
    const next = sessionSamples[i + 1];
    const spanEnd = next ? next.time : end;
    const spanMs = spanEnd.getTime() - sample.time.getTime();
    const spanH = spanMs / 3_600_000;
    energyWh += sample.watts * spanH;
    if (sample.watts > 50) compressorMs += spanMs;
  }

  const energyKwh = energyWh / 1000;
  const costInr = energyKwh * INR_PER_KWH;
  const dutyPct = durationMs > 0 ? Math.round((compressorMs / durationMs) * 100) : 0;
  const durStr = formatDuration(durationMs);

  acLog("SESSION", `duration=${durStr}  energy=${energyKwh.toFixed(2)}kWh  cost=INR ${costInr.toFixed(1)}  duty=${dutyPct}%`);
  acLog("END", "AC session ended");

  sessionStart = null;
  sessionSamples = [];
}

export function acLogPhase(phase: string, details: string): void {
  acLog("PHASE", `${phase}: ${details}`);
}

export function acLogWatchdog(details: string): void {
  acLog("WATCHDOG", details);
}

export function acLogError(context: string, err: string): void {
  acLog("ERROR", `${context}: ${err}`);
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${m > 0 ? `${m}m` : ""}`;
}
