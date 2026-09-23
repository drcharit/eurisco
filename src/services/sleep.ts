/**
 * Sleep data handler for the ingest server.
 *
 * Parses Apple Health sleep stage data from iOS Shortcuts.
 * Saves to workspace/sleep/YYYY-MM-DD.log.
 *
 * Expected POST body (plain text, one line per stage):
 *   start|end|stage
 *
 * Accepts ISO dates or iOS Shortcuts format:
 *   9 Mar 2026 at 1:24 AM|9 Mar 2026 at 1:25 AM|REM
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IngestHandler, IngestResult } from "./ingest.js";
import { appendSleepToSheet } from "./sleep-sheet.js";

export function createSleepHandler(workspaceDir: string): IngestHandler {
  const sleepDir = resolve(workspaceDir, "sleep");
  if (!existsSync(sleepDir)) mkdirSync(sleepDir, { recursive: true });

  return {
    path: "sleep",
    async handle(body: string): Promise<IngestResult> {
      const result = parseSleepData(body);
      if (!result) {
        return { response: { ok: false, error: "Could not parse sleep data" } };
      }

      saveSleepLog(sleepDir, result.date, result.raw, result.summary);

      // Update Google Sheet
      try {
        const sheetRow = buildSheetRow(result);
        const sheetMsg = await appendSleepToSheet(sheetRow);
        console.log(`[sleep] ${sheetMsg}`);
      } catch (e) {
        console.error(`[sleep] Sheet update failed: ${(e as Error).message}`);
      }

      return {
        response: { ok: true, date: result.date, stages: result.stages.length },
        notification: formatSleepSummary(result),
      };
    },
  };
}

/** Read the sleep log for a given date (YYYY-MM-DD) */
export function readSleepLog(workspaceDir: string, date: string): string | null {
  const path = resolve(workspaceDir, "sleep", `${date}.log`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// ── Internals ──

interface SleepStage {
  start: Date;
  end: Date;
  stage: string;
  durationMin: number;
}

interface SleepResult {
  date: string;
  stages: SleepStage[];
  raw: string;
  summary: string;
}

function parseSleepData(body: string): SleepResult | null {
  const lines = body.trim().split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  const stages: SleepStage[] = [];

  for (const line of lines) {
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;

    const start = parseDate(parts[0]!);
    const end = parseDate(parts[1]!);
    const stage = normalizeStage(parts[2]!);

    if (!start || !end) continue;

    const durationMin = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (durationMin <= 0) continue;

    stages.push({ start, end, stage, durationMin });
  }

  if (stages.length === 0) return null;

  stages.sort((a, b) => a.start.getTime() - b.start.getTime());

  // Filter to last night's window: 6 PM yesterday → noon today
  const filtered = filterLastNight(stages);
  if (!filtered) return null;

  // Sleep date = yesterday (the evening the night started)
  const dateStr = filtered.nightDate;

  stages.length = 0;
  stages.push(...filtered.stages);

  // Build summary
  const totalMin = stages.reduce((sum, s) => sum + s.durationMin, 0);
  const byStage: Record<string, number> = {};
  for (const s of stages) {
    byStage[s.stage] = (byStage[s.stage] ?? 0) + s.durationMin;
  }

  const summary = [
    `Total: ${formatMin(totalMin)}`,
    ...Object.entries(byStage).map(([k, v]) => `${k}: ${formatMin(v)}`),
  ].join("  ");

  // Build raw text from filtered stages only
  const raw = stages.map((s) => {
    const fmt = (d: Date): string => d.toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    return `${fmt(s.start)}|${fmt(s.end)}|${s.stage}`;
  }).join("\n");

  return { date: dateStr, stages, raw, summary };
}

/**
 * Filter stages to last night's window (6 PM yesterday → noon today).
 * Handles fragmented sleep: waking up mid-night and returning to sleep
 * is still counted as one night. Daytime naps from the previous day
 * are excluded.
 */
function filterLastNight(stages: SleepStage[]): { stages: SleepStage[]; nightDate: string } | null {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Night window: 6 PM yesterday to noon today
  const windowStart = new Date(today.getTime() - 6 * 3_600_000);  // yesterday 18:00
  const windowEnd = new Date(today.getTime() + 12 * 3_600_000);   // today 12:00

  const nightStages = stages.filter((s) =>
    s.start.getTime() >= windowStart.getTime() && s.start.getTime() < windowEnd.getTime(),
  );

  if (nightStages.length === 0) return null;

  // Night date = yesterday (the evening)
  const yesterday = new Date(today.getTime() - 24 * 3_600_000);
  const nightDate = yesterday.toISOString().slice(0, 10);

  return { stages: nightStages, nightDate };
}

function buildSheetRow(result: SleepResult): {
  date: string; bedtime: string; wakeup: string;
  totalMin: number; deepMin: number; coreMin: number; remMin: number; awakeMin: number;
  fragments: number;
  stages: Array<{ start: string; end: string; stage: string; durationMin: number }>;
} {
  const { stages, date } = result;
  const first = stages[0]!;
  const last = stages[stages.length - 1]!;

  const timeFmt = (d: Date): string =>
    d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  const bedtime = timeFmt(first.start);
  const wakeup = timeFmt(last.end);

  const totalMin = stages.reduce((sum, s) => sum + s.durationMin, 0);
  const byStage: Record<string, number> = {};
  for (const s of stages) {
    byStage[s.stage] = (byStage[s.stage] ?? 0) + s.durationMin;
  }

  // Count fragments: gaps > 30 min between consecutive stages
  let fragments = 0;
  for (let i = 1; i < stages.length; i++) {
    const gap = stages[i]!.start.getTime() - stages[i - 1]!.end.getTime();
    if (gap > 30 * 60_000) fragments++;
  }

  const stageRows = stages.map((s) => ({
    start: timeFmt(s.start),
    end: timeFmt(s.end),
    stage: s.stage,
    durationMin: s.durationMin,
  }));

  return {
    date, bedtime, wakeup, totalMin,
    deepMin: byStage["Deep"] ?? 0,
    coreMin: byStage["Core"] ?? 0,
    remMin: byStage["REM"] ?? 0,
    awakeMin: byStage["Awake"] ?? 0,
    fragments,
    stages: stageRows,
  };
}

function parseDate(s: string): Date | null {
  const iso = new Date(s);
  if (!isNaN(iso.getTime())) return iso;

  // iOS Shortcuts format: "9 Mar 2026 at 1:24 AM"
  const match = s.match(
    /(\d{1,2})\s+(\w{3})\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  );
  if (!match) return null;

  const [, day, mon, year, hour, min, ampm] = match;
  const months: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };

  let h = Number(hour);
  if (ampm!.toUpperCase() === "PM" && h !== 12) h += 12;
  if (ampm!.toUpperCase() === "AM" && h === 12) h = 0;

  const d = new Date(Number(year), months[mon!] ?? 0, Number(day), h, Number(min));
  return isNaN(d.getTime()) ? null : d;
}

function normalizeStage(s: string): string {
  const lower = s.toLowerCase().trim();
  if (lower === "rem") return "REM";
  if (lower === "core" || lower === "light") return "Core";
  if (lower === "deep") return "Deep";
  if (lower === "awake" || lower === "inbed") return "Awake";
  return s.trim();
}

function formatMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function saveSleepLog(sleepDir: string, date: string, raw: string, summary: string): void {
  const path = resolve(sleepDir, `${date}.log`);
  const header = `# Sleep: ${date}\n# ${summary}\n\n`;
  const content = header + raw + "\n";
  writeFileSync(path, content);
  console.log(`[sleep] Saved ${date}: ${summary}`);
}

function formatSleepSummary(result: SleepResult): string {
  const { stages, summary, date } = result;
  const first = stages[0]!;
  const last = stages[stages.length - 1]!;

  const bedtime = first.start.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const wakeup = last.end.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  const lines = [
    `Sleep Report: ${date}`,
    `Bed: ${bedtime} — Wake: ${wakeup}`,
    summary,
    "",
    ...stages.map((s) => {
      const t1 = s.start.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
      const t2 = s.end.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
      return `${t1}-${t2} ${s.stage} (${s.durationMin}m)`;
    }),
  ];

  return lines.join("\n");
}
