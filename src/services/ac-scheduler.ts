/**
 * AC night schedule using node-cron + configurable profiles.
 *
 * Profiles are loaded from config/ac-profiles.json.
 * Each profile has named phases with cron expressions.
 *
 * Power watchdog (22:00–05:00):
 *   Polls the smart plug every 5 min during scheduled hours.
 *   Logs ALL power samples (compressor + standby) for energy tracking.
 *   Computes compressor duty cycle.
 *   Detects true manual off: 0W = unplugged/breaker off.
 *   Standby 14–16W = AC powered, compressor thermostat-cycling (normal).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import type { ACCredentials } from "./ac.js";
import { acOn, acOff, acPowerDraw } from "./ac.js";
import {
  initACLog, acLog, acLogSessionStart, acLogSessionEnd,
  acLogSample, acLogPhase, acLogWatchdog, acLogError,
} from "./ac-log.js";

interface Phase {
  time: string;
  cron: string;
  temp?: number;
  mode?: number;
  fan?: number;
  action: "on" | "off";
}

interface Profile {
  name: string;
  phases: Phase[];
  resetCron: string;
}

type Profiles = Record<string, Profile>;

// ── State ──

let state: "active" | "paused" | "skipped" = "active";
let activeProfile = "default";
let profiles: Profiles = {};
let tasks: ScheduledTask[] = [];
let creds: ACCredentials;
let notify: (text: string) => Promise<void>;

/**
 * Power thresholds (from real data — Mar 11 log):
 *   Compressor on:  2136–2599W
 *   Standby (AC powered, compressor off): 14–16W
 *   True off (unplugged/breaker): 0W
 *
 * Manual off = 0W (not standby). Compressor cycling at 14-16W is normal.
 */
const OFF_THRESHOLD = 20;      // ≤20W = AC off (Daikin standby draws 14-16W, compressor off)
const ON_THRESHOLD = 5;        // >5W = AC on (standby 14-16W or compressor 2000W+)
const UNPLUG_CONFIRM_COUNT = 3; // 3 consecutive 0W readings = 15 min
let consecutiveZero = 0;
let acPowered = false;  // Is the AC unit receiving power? (standby or running)
let sessionActive = false;  // Is there a schedule-initiated session?

function loadProfiles(rootDir: string): Profiles {
  const path = resolve(rootDir, "config", "ac-profiles.json");
  return JSON.parse(readFileSync(path, "utf-8")) as Profiles;
}

// ── Schedule ──

function scheduleProfile(profile: Profile): void {
  for (const t of tasks) t.stop();
  tasks = [];

  for (const phase of profile.phases) {
    const task = cron.schedule(phase.cron, () => {
      acLog("CRON", `Firing phase ${phase.time} (${phase.action})`);
      executePhase(phase).catch((e) => {
        acLogError(phase.time, `executePhase crashed: ${(e as Error).message}`);
      });
    });
    tasks.push(task);
  }

  const resetTask = cron.schedule(profile.resetCron, () => {
    if (state === "skipped") {
      state = "active";
      acLog("RESET", "Skip reset — schedule active again");
    }
  });
  tasks.push(resetTask);
}

const MAX_RETRIES = 3;
const VERIFY_DELAY_MS = 30_000; // 30s — give compressor time to respond

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function executePhase(phase: Phase): Promise<void> {
  if (state !== "active") {
    acLogPhase(phase.time, `skipped (state=${state})`);
    return;
  }

  if (phase.action === "off") {
    await executeOff(phase);
  } else {
    await executeOn(phase);
  }
}

async function executeOff(phase: Phase): Promise<void> {
  acLogPhase(phase.time, "OFF");

  // Try IR off up to MAX_RETRIES times, verify with power draw
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await acOff(creds);
    } catch (e) {
      acLogError(phase.time, `IR attempt ${attempt}: ${(e as Error).message}`);
      continue;
    }

    // Wait 60s — Daikin may take time to fully power down after IR off
    await delay(60_000);

    try {
      const watts = await acPowerDraw(creds);
      if (watts <= OFF_THRESHOLD) {
        acLogPhase(phase.time, `OFF confirmed at ${watts.toFixed(0)}W (IR attempt ${attempt})`);
        endSession();
        await notify(`AC off (verified on attempt ${attempt})`);
        return;
      }
      acLogWatchdog(`IR OFF attempt ${attempt} — still at ${watts.toFixed(0)}W, retrying`);
    } catch (e) {
      acLogError(phase.time, `verify failed: ${(e as Error).message}`);
    }
  }

  // IR commands failed — notify, do NOT cut power (Daikin restarts on power cycle)
  acLogError(phase.time, `IR OFF failed ${MAX_RETRIES}× — AC may still be running`);
  endSession();
  await notify(`WARNING: AC OFF command failed after ${MAX_RETRIES} attempts. Please turn off manually.`);
}

function endSession(): void {
  if (sessionActive) {
    acLogSessionEnd();
    sessionActive = false;
  }
}

async function executeOn(phase: Phase): Promise<void> {
  const t = phase.temp ?? 24;
  const m = phase.mode ?? 0;
  const f = phase.fan ?? 1;

  if (!sessionActive) {
    acLogSessionStart();
    sessionActive = true;
  }
  acLogPhase(phase.time, `ON ${t}°C mode=${m} fan=${f}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await acOn(creds, t, m, f);
    } catch (e) {
      acLogError(phase.time, `attempt ${attempt}: ${(e as Error).message}`);
      continue;
    }

    await delay(VERIFY_DELAY_MS);

    try {
      const watts = await acPowerDraw(creds);
      // AC powered = standby (>5W) or compressor running (>50W)
      if (watts > ON_THRESHOLD) {
        acLogPhase(phase.time, `ON confirmed at ${watts.toFixed(0)}W (attempt ${attempt})`);
        acPowered = true;
        await notify(`AC: ${t}°C (verified on attempt ${attempt})`);
        return;
      }
      acLogWatchdog(`ON attempt ${attempt} failed — 0W, retrying`);
    } catch (e) {
      acLogError(phase.time, `verify failed: ${(e as Error).message}`);
    }
  }

  acLogError(phase.time, `ON failed after ${MAX_RETRIES} attempts — AC may not have started`);
  await notify(`WARNING: AC ON command failed after ${MAX_RETRIES} attempts. Please turn on manually.`);
}

// ── Power Watchdog ──

function startWatchdog(): void {
  cron.schedule("*/5 22-23,0-4 * * *", async () => {
    if (state === "paused") return;
    try {
      const watts = await acPowerDraw(creds);

      // Log every reading if session is active
      if (sessionActive) {
        acLogSample(watts);
      }

      // Track if AC unit has power
      if (watts > ON_THRESHOLD) {
        consecutiveZero = 0;
        if (!acPowered) {
          acPowered = true;
          acLogWatchdog(`AC powered on (${watts.toFixed(0)}W)`);
        }
      } else {
        consecutiveZero++;
      }

      // Detect true manual off: 0W for 15 min = unplugged or breaker off
      if (acPowered && consecutiveZero >= UNPLUG_CONFIRM_COUNT) {
        acPowered = false;
        acLogWatchdog(`AC unplugged/off at breaker (0W × ${consecutiveZero} readings)`);
        if (sessionActive) {
          acLogSessionEnd();
          sessionActive = false;
          state = "skipped";
          await notify("AC lost power (unplugged?). Tonight's schedule paused.");
        }
      }
    } catch (e) {
      acLogError("watchdog", (e as Error).message);
    }
  });

  console.log("AC power watchdog: polling every 5 min (22:00–05:00)");
}

// ── Public API ──

export function acSchedulerSkip(): string {
  state = "skipped";
  acLog("CONTROL", "Schedule skipped for tonight");
  return "AC schedule skipped for tonight. Resumes tomorrow.";
}

export function acSchedulerPause(): string {
  state = "paused";
  acLog("CONTROL", "Schedule paused");
  return "AC schedule paused until you say 'start ac'.";
}

export function acSchedulerResume(): string {
  state = "active";
  consecutiveZero = 0;
  acLog("CONTROL", "Schedule resumed");
  return "AC schedule resumed.";
}

export function acSchedulerState(): string {
  const parts: string[] = [state];
  if (sessionActive) parts.push("session active");
  if (acPowered) parts.push("AC powered");
  return parts.join(", ");
}

export function acSchedulerProfile(): string {
  const p = profiles[activeProfile];
  if (!p) return activeProfile;
  const phases = p.phases.map((ph) =>
    ph.action === "off" ? `${ph.time} OFF` : `${ph.time} ${ph.temp}°C`,
  ).join(" → ");
  return `${p.name} (${phases})`;
}

export function acSchedulerSetProfile(name: string): string {
  const p = profiles[name];
  if (!p) {
    const available = Object.keys(profiles).join(", ");
    return `Unknown profile "${name}". Available: ${available}`;
  }
  activeProfile = name;
  scheduleProfile(p);
  acLog("CONTROL", `Profile switched to: ${name}`);
  const phases = p.phases.map((ph) =>
    ph.action === "off" ? `${ph.time} OFF` : `${ph.time} ${ph.temp}°C`,
  ).join(" → ");
  return `Switched to "${p.name}": ${phases}`;
}

export function acSchedulerListProfiles(): string {
  const lines: string[] = [];
  for (const [key, p] of Object.entries(profiles)) {
    const marker = key === activeProfile ? " (active)" : "";
    const phases = p.phases.map((ph) =>
      ph.action === "off" ? `${ph.time} OFF` : `${ph.time} ${ph.temp}°C`,
    ).join(" → ");
    lines.push(`${key}: ${p.name}${marker} — ${phases}`);
  }
  return lines.join("\n");
}

export function startACScheduler(
  rootDir: string,
  credentials: ACCredentials,
  sendNotification: (text: string) => Promise<void>,
): void {
  creds = credentials;
  notify = sendNotification;
  profiles = loadProfiles(rootDir);

  initACLog(resolve(rootDir, "workspace"));

  const profile = profiles[activeProfile];
  if (!profile) {
    console.log("[ac] No default profile found in ac-profiles.json");
    return;
  }

  scheduleProfile(profile);
  startWatchdog();
  catchUpMissedPhases(profile);
  acLog("INIT", `Profile: ${acSchedulerProfile()}`);
  console.log(`AC schedule: ${acSchedulerProfile()}`);
}

/**
 * On startup, check if any phase should have already fired tonight.
 * If Eurisco restarts after 22:00, the "0 22 * * *" cron won't fire until tomorrow.
 * This finds the latest phase that should be active right now and executes it.
 */
function catchUpMissedPhases(profile: Profile): void {
  const now = new Date();
  const hhmm = now.getHours() * 100 + now.getMinutes(); // e.g. 2215 for 22:15

  // Parse phase times into comparable numbers
  const phasesByTime = profile.phases.map((p) => {
    const [h, m] = p.time.split(":").map(Number);
    return { phase: p, hhmm: h! * 100 + m! };
  }).sort((a, b) => a.hhmm - b.hhmm);

  // Find the latest phase that should have already fired
  // Night schedule wraps: 22:00, 01:00, 04:00
  // If current time is 22:15, the 22:00 phase was missed
  // If current time is 02:00, both 22:00 and 01:00 were missed — execute 01:00
  let missedPhase: Phase | null = null;

  for (const { phase, hhmm: phaseTime } of phasesByTime) {
    if (phaseTime <= hhmm) {
      missedPhase = phase;
    }
  }

  // Handle wrap-around: if it's after midnight (e.g. 02:00) and phases exist
  // before midnight (22:00), those count as missed too — but we want the latest
  // applicable phase. After-midnight phases take priority if they've passed.
  // The sort + loop above handles this: 01:00 < 04:00 < 22:00
  // At 02:00, hhmm=200, so only 01:00 (100) matches → correct.
  // At 22:30, hhmm=2230, all phases match → last one is 22:00 → correct.

  if (!missedPhase) return;

  // Don't catch up OFF phases — if we just started, we want the AC on
  if (missedPhase.action === "off") {
    acLog("CATCHUP", `Skipping catch-up for OFF phase (${missedPhase.time})`);
    return;
  }

  acLog("CATCHUP", `Executing missed phase: ${missedPhase.time} ${missedPhase.action}`);
  executePhase(missedPhase).catch((e) => {
    acLogError("CATCHUP", `Failed: ${(e as Error).message}`);
  });
}
