/**
 * Strava API client + sync engine.
 *
 * Fetches activities from Strava, classifies run types,
 * stores in eurisco.db, and updates Google Sheets.
 * Runs on a cron schedule (default: every 2 hours).
 */

import cron from "node-cron";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import type { GoogleAccount } from "./google-auth.js";
import { updateTrainingSheet } from "./strava-sheet.js";

const STRAVA_API = "https://www.strava.com/api/v3";
const EST_MAX_HR = 172; // age 48, 220 - 48

// ── Token cache ──
let cachedToken = "";
let tokenExpiresAt = 0;

interface StravaTokenConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function getToken(creds: StravaTokenConfig): Promise<string> {
  if (cachedToken && Date.now() / 1000 < tokenExpiresAt - 300) return cachedToken;

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_at: number };
  cachedToken = data.access_token;
  tokenExpiresAt = data.expires_at;
  return cachedToken;
}

// ── Strava API ──

interface StravaActivity {
  id: number;
  name: string;
  type: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  total_elevation_gain?: number;
}

interface StravaLap {
  distance: number;
  moving_time: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
}

async function fetchActivities(token: string, afterTs: number, perPage = 30): Promise<StravaActivity[]> {
  const url = `${STRAVA_API}/athlete/activities?per_page=${perPage}&after=${Math.floor(afterTs)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Strava activities: ${res.status}`);
  return (await res.json()) as StravaActivity[];
}

async function fetchDetail(token: string, id: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRAVA_API}/activities/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Strava detail: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function fetchHRStream(token: string, id: number): Promise<number[] | null> {
  const res = await fetch(`${STRAVA_API}/activities/${id}/streams?keys=heartrate&key_type=time`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const streams = (await res.json()) as { type: string; data: number[] }[];
  const hr = streams.find((s) => s.type === "heartrate");
  return hr?.data ?? null;
}

// ── Classification ──

interface Lap {
  distance: number;
  movingTime: number;
  pace: string;
  paceSecPerKm: number;
  avgHR: number;
  maxHR: number;
}

function formatPace(secPerKm: number): string {
  if (secPerKm <= 0) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.floor(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function extractLaps(detail: Record<string, unknown>): Lap[] | null {
  const raw = detail["laps"] as StravaLap[] | undefined;
  if (!raw) return null;
  return raw.map((l) => {
    const dist = l.distance;
    const paceS = dist > 0 ? l.moving_time / (dist / 1000) : 0;
    return {
      distance: Math.round(dist),
      movingTime: l.moving_time,
      pace: formatPace(paceS),
      paceSecPerKm: Math.round(paceS * 10) / 10,
      avgHR: Math.round(l.average_heartrate ?? 0),
      maxHR: Math.round(l.max_heartrate ?? 0),
    };
  });
}

function computeHRZones(hrData: number[]): Record<string, number> {
  const zones: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const thresholds = [0.60, 0.70, 0.80, 0.90];
  for (const hr of hrData) {
    const pct = hr / EST_MAX_HR;
    if (pct < thresholds[0]!) zones[1]!++;
    else if (pct < thresholds[1]!) zones[2]!++;
    else if (pct < thresholds[2]!) zones[3]!++;
    else if (pct < thresholds[3]!) zones[4]!++;
    else zones[5]!++;
  }
  const total = hrData.length;
  return Object.fromEntries(
    Object.entries(zones).map(([z, c]) => [`Z${z}`, Math.round((c / total) * 100)]),
  );
}

function classifyRun(laps: Lap[] | null, distKm: number, avgHR: number | undefined, _durationSec: number): string {
  if (!laps || laps.length < 2) return distKm >= 7 ? "Long Run" : "Easy Run";

  const meaningful = laps.filter((l) => l.distance > 100 && l.paceSecPerKm > 0);
  if (meaningful.length === 0) return "Easy Run";

  const meanPace = meaningful.reduce((s, l) => s + l.paceSecPerKm, 0) / meaningful.length;
  const variance = meaningful.reduce((s, l) => s + (l.paceSecPerKm - meanPace) ** 2, 0) / meaningful.length;
  const cv = meanPace > 0 ? (Math.sqrt(variance) / meanPace) * 100 : 0;

  // Check for alternating fast/slow pattern
  let hasFastSlow = false;
  if (laps.length >= 4) {
    const fast = laps.filter((l) => l.distance > 200 && l.paceSecPerKm < meanPace * 0.85);
    const slow = laps.filter((l) => l.distance > 50 && l.paceSecPerKm > meanPace * 1.15);
    hasFastSlow = fast.length >= 2 && slow.length >= 1;
  }

  const hrPct = avgHR ? (avgHR / EST_MAX_HR) * 100 : 0;

  if (cv > 15 && (hasFastSlow || laps.length >= 4)) return "Intervals";
  if (8 < cv && cv <= 15 && hrPct > 75) return "Tempo Run";
  if (distKm >= 8) return "Long Run";
  if (hrPct > 80) return "Tempo Run";
  return "Easy Run";
}

function classifyActivity(stravaType: string, laps: Lap[] | null, distKm: number, avgHR: number | undefined, dur: number): string {
  const typeMap: Record<string, string> = {
    Walk: "Walk", WeightTraining: "Strength Training", Workout: "Functional Training",
    Yoga: "Yoga", Ride: "Cycling", Swim: "Swimming", Hike: "Hike", CrossFit: "Functional Training",
  };
  if (typeMap[stravaType]) return typeMap[stravaType]!;
  if (stravaType === "Run") return classifyRun(laps, distKm, avgHR, dur);
  return stravaType;
}

// ── Storage ──

function storeActivity(
  db: Database.Database,
  activity: StravaActivity,
  detail: Record<string, unknown> | null,
  _token: string,
  hrData: number[] | null,
): boolean {
  const existing = db.prepare("SELECT 1 FROM workouts WHERE strava_id = ?").get(activity.id);
  if (existing) return false;

  const distKm = activity.distance / 1000;
  const paceSecKm = distKm > 0 ? activity.moving_time / distKm : 0;
  const paceStr = formatPace(paceSecKm);

  let splitsJson: string | null = null;
  if (detail && detail["splits_metric"]) {
    const splits = (detail["splits_metric"] as Array<Record<string, number>>).map((s) => ({
      km: s["split"],
      distance: s["distance"],
      movingTime: s["moving_time"],
      pace: formatPace(s["distance"]! > 0 ? s["moving_time"]! / (s["distance"]! / 1000) : 0),
      avgHR: s["average_heartrate"] ?? 0,
    }));
    splitsJson = JSON.stringify(splits);
  }

  const laps = detail ? extractLaps(detail) : null;
  const hrZones = hrData ? computeHRZones(hrData) : null;
  const workoutType = classifyActivity(activity.type, laps, distKm, activity.average_heartrate, activity.moving_time);
  const date = activity.start_date_local.slice(0, 10);

  db.prepare(`INSERT INTO workouts
    (strava_id, date, name, strava_type, workout_type, distance_km, moving_time_sec,
     elapsed_time_sec, pace_per_km, pace_decimal, avg_heartrate, max_heartrate,
     avg_cadence, total_elevation, calories, splits_json, laps_json, hr_zones_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    activity.id, date, activity.name, activity.type, workoutType,
    Math.round(distKm * 100) / 100, activity.moving_time, activity.elapsed_time ?? activity.moving_time,
    paceStr, Math.round((paceSecKm / 60) * 100) / 100,
    activity.average_heartrate ?? null, activity.max_heartrate ?? null,
    activity.average_cadence ?? null, activity.total_elevation_gain ?? 0,
    (detail as Record<string, number> | null)?.["calories"] ?? 0,
    splitsJson, laps ? JSON.stringify(laps) : null, hrZones ? JSON.stringify(hrZones) : null,
  );

  console.log(`[strava] Stored: ${date} [${workoutType}] ${activity.name}, ${distKm.toFixed(1)}km, ${paceStr}`);
  return true;
}

// ── Sync engine ──

async function runSync(
  config: Config,
  db: Database.Database,
  account: GoogleAccount | undefined,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const creds: StravaTokenConfig = {
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    refreshToken: config.stravaRefreshToken,
  };

  const token = await getToken(creds);

  // Fetch activities from last 30 days
  const afterTs = (Date.now() - 30 * 86400_000) / 1000;
  console.log("[strava] Fetching activities...");
  const activities = await fetchActivities(token, afterTs);

  let newCount = 0;
  for (const activity of activities) {
    let detail: Record<string, unknown> | null = null;
    let hrData: number[] | null = null;

    if (["Run", "Walk", "Hike"].includes(activity.type)) {
      try {
        detail = await fetchDetail(token, activity.id);
        await sleep(500);
        hrData = await fetchHRStream(token, activity.id);
        await sleep(300);
      } catch (e) {
        console.log(`[strava] Detail fetch failed for ${activity.id}: ${(e as Error).message}`);
      }
    }

    if (storeActivity(db, activity, detail, token, hrData)) newCount++;
  }

  console.log(`[strava] Stored ${newCount} new (${activities.length} fetched)`);

  // Update Google Sheet
  if (account && config.stravaSheetId) {
    try {
      await updateTrainingSheet(db, account, config.stravaSheetId);
    } catch (e) {
      console.log(`[strava] Sheet update failed: ${(e as Error).message}`);
    }
  }

  if (newCount > 0) {
    const latest = db.prepare(
      "SELECT date, workout_type, distance_km, pace_per_km FROM workouts ORDER BY date DESC LIMIT 1",
    ).get() as { date: string; workout_type: string; distance_km: number; pace_per_km: string } | undefined;
    if (latest) {
      await notify(`Strava sync: ${newCount} new. Latest: ${latest.date} ${latest.workout_type} ${latest.distance_km}km ${latest.pace_per_km}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public API ──

export async function syncNow(
  config: Config,
  db: Database.Database,
  account: GoogleAccount | undefined,
  notify: (text: string) => Promise<void>,
): Promise<string> {
  try {
    await runSync(config, db, account, notify);
    const count = (db.prepare("SELECT COUNT(*) as c FROM workouts").get() as { c: number }).c;
    return `Sync complete. ${count} total workouts in DB.`;
  } catch (e) {
    return `Sync failed: ${(e as Error).message}`;
  }
}

export function startStravaSync(
  config: Config,
  db: Database.Database,
  account: GoogleAccount | undefined,
  notify: (text: string) => Promise<void>,
): void {
  cron.schedule(config.stravaSyncCron, async () => {
    console.log("[strava] Cron sync starting...");
    try {
      await runSync(config, db, account, notify);
    } catch (e) {
      console.log(`[strava] Sync error: ${(e as Error).message}`);
    }
  });
  console.log(`[strava] Scheduled: ${config.stravaSyncCron}`);
}
