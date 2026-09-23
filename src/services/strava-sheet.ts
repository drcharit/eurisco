/**
 * Google Sheets integration for Strava training data.
 *
 * Updates the TCS 10K Training Plan spreadsheet:
 * - Daily Training Log tab: actual workout data matched to training dates
 * - Workout Analysis tab: detailed session breakdowns
 * - Progress Dashboard tab: weekly totals + chart data
 */

import { google } from "googleapis";
import type Database from "better-sqlite3";
import type { GoogleAccount } from "./google-auth.js";

// Training plan dates → expected workout type
export const TRAINING_DAYS: Record<string, { type: string; plannedKm: number }> = {
  "2026-03-17": { type: "Speed/Intervals", plannedKm: 5.0 },
  "2026-03-19": { type: "Tempo Run", plannedKm: 4.5 },
  "2026-03-21": { type: "Long Run", plannedKm: 8.0 },
  "2026-03-24": { type: "Speed/Intervals", plannedKm: 5.5 },
  "2026-03-26": { type: "Tempo Run", plannedKm: 5.0 },
  "2026-03-28": { type: "Long Run", plannedKm: 9.0 },
  "2026-03-31": { type: "Easy Run", plannedKm: 4.0 },
  "2026-04-02": { type: "Short Tempo", plannedKm: 4.0 },
  "2026-04-04": { type: "Long Run (reduced)", plannedKm: 7.0 },
  "2026-04-07": { type: "Speed/Intervals", plannedKm: 6.5 },
  "2026-04-09": { type: "Tempo Run", plannedKm: 5.5 },
  "2026-04-11": { type: "Long Run", plannedKm: 10.0 },
  "2026-04-14": { type: "Race Pace Intervals", plannedKm: 6.5 },
  "2026-04-16": { type: "Tempo Run", plannedKm: 5.0 },
  "2026-04-18": { type: "Long Run (reduced)", plannedKm: 8.0 },
  "2026-04-21": { type: "Short Sharpener", plannedKm: 4.0 },
  "2026-04-23": { type: "Easy Shakeout", plannedKm: 3.0 },
  "2026-04-26": { type: "RACE DAY", plannedKm: 10.0 },
};

const WEEK_RANGES: [number, string, string][] = [
  [1, "2026-03-16", "2026-03-22"],
  [2, "2026-03-23", "2026-03-29"],
  [3, "2026-03-30", "2026-04-05"],
  [4, "2026-04-06", "2026-04-12"],
  [5, "2026-04-13", "2026-04-19"],
  [6, "2026-04-20", "2026-04-26"],
];

interface WorkoutRow {
  strava_id: number;
  date: string;
  name: string;
  workout_type: string;
  distance_km: number;
  moving_time_sec: number;
  pace_per_km: string;
  avg_heartrate: number | null;
  max_heartrate: number | null;
  avg_cadence: number | null;
  splits_json: string | null;
  laps_json: string | null;
  hr_zones_json: string | null;
  calories: number | null;
}

/** Update all tabs in the training sheet. */
export async function updateTrainingSheet(
  db: Database.Database,
  account: GoogleAccount,
  sheetId: string,
): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth: account.auth });

  await updateDailyLog(db, sheets, sheetId);
  await updateWeeklyTotals(db, sheets, sheetId);

  console.log("[strava-sheet] Sheet update complete");
}

// ── Daily Training Log ──

async function updateDailyLog(
  db: Database.Database,
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
): Promise<void> {
  // Get unsynced running activities
  const rows = db.prepare(
    "SELECT * FROM workouts WHERE strava_type = 'Run' AND synced_to_sheet = 0 ORDER BY date",
  ).all() as WorkoutRow[];

  if (rows.length === 0) return;

  // Build date→row mapping from sheet
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Daily Training Log!A:A",
  });
  const sheetRows = existing.data.values ?? [];
  const dateRowMap = new Map<string, number>();

  for (let i = 0; i < sheetRows.length; i++) {
    const cell = (sheetRows[i]?.[0] ?? "").trim();
    for (const fmt of [parseDateDDMon]) {
      const parsed = fmt(cell);
      if (parsed) { dateRowMap.set(parsed, i + 1); break; }
    }
  }

  let updated = 0;
  for (const row of rows) {
    if (!dateRowMap.has(row.date)) {
      console.log(`[strava-sheet] ${row.date} not in training plan — local only`);
      continue;
    }

    const sheetRow = dateRowMap.get(row.date)!;
    const notes = buildNotes(row);

    // Update columns G (Notes), H (Distance), I (Difficulty)
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Daily Training Log!G${sheetRow}:I${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          notes,
          `${row.distance_km.toFixed(1)} km`,
          estimateDifficulty(row.avg_heartrate) ?? "",
        ]],
      },
    });

    db.prepare("UPDATE workouts SET synced_to_sheet = 1 WHERE strava_id = ?").run(row.strava_id);
    updated++;
    console.log(`[strava-sheet] Updated row ${sheetRow} for ${row.date}: ${row.distance_km}km`);
    await delay(500);
  }

  if (updated > 0) console.log(`[strava-sheet] Daily log: ${updated} rows updated`);
}

// ── Weekly totals on dashboard ──

async function updateWeeklyTotals(
  db: Database.Database,
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
): Promise<void> {
  for (let i = 0; i < WEEK_RANGES.length; i++) {
    const [, start, end] = WEEK_RANGES[i]!;
    const result = db.prepare(
      "SELECT COALESCE(SUM(distance_km), 0) as total FROM workouts WHERE strava_type = 'Run' AND date BETWEEN ? AND ?",
    ).get(start, end) as { total: number };

    if (result.total > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Progress Dashboard!D${14 + i}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[Math.round(result.total * 10) / 10]] },
      });
      await delay(500);
    }
  }
}

// ── Helpers ──

function buildNotes(row: WorkoutRow): string {
  const parts = [row.name];
  if (row.avg_heartrate) parts.push(`Avg HR: ${Math.round(row.avg_heartrate)}`);
  if (row.max_heartrate) parts.push(`Max HR: ${Math.round(row.max_heartrate)}`);
  if (row.avg_cadence) parts.push(`Cadence: ${Math.round(row.avg_cadence)}`);
  if (row.splits_json) {
    const splits = JSON.parse(row.splits_json) as { km: number; pace: string }[];
    const strs = splits.slice(0, 10).map((s) => `KM${s.km}: ${s.pace}`);
    parts.push("Splits: " + strs.join(" | "));
  }
  return parts.join(" | ");
}

function estimateDifficulty(avgHR: number | null): number | null {
  if (!avgHR) return null;
  const pct = (avgHR / 172) * 100;
  if (pct < 60) return 2;
  if (pct < 70) return 3;
  if (pct < 75) return 4;
  if (pct < 80) return 5;
  if (pct < 85) return 6;
  if (pct < 90) return 7;
  if (pct < 95) return 8;
  return 9;
}

function parseDateDDMon(cell: string): string | null {
  // Parse "17-Mar", "1-Apr" etc → "2026-03-17"
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const m = cell.match(/^(\d{1,2})-(\w{3})$/);
  if (!m) return null;
  const mon = months[m[2]!];
  if (!mon) return null;
  return `2026-${mon}-${m[1]!.padStart(2, "0")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
