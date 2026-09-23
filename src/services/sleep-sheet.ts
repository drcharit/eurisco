/**
 * Google Sheets integration for sleep data.
 *
 * Creates/updates a "Eurisco Sleep Log" spreadsheet in the user's Google Drive.
 * - Summary sheet: one row per night with key metrics.
 * - Raw Data sheet: every sleep stage with timestamps.
 * Sheet ID is persisted to workspace/sleep/sheet-id.txt.
 */

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { GoogleAccount } from "./google-auth.js";

const SHEET_TITLE = "Eurisco Sleep Log";
const SUMMARY_SHEET = "Summary";
const RAW_SHEET = "Raw Data";
const SUMMARY_HEADER = [
  "Date", "Bed", "Wake", "Total", "Deep (m)", "Core (m)", "REM (m)", "Awake (m)", "Fragments",
];
const RAW_HEADER = [
  "Date", "Start", "End", "Stage", "Duration (m)",
];

interface SleepStageRow {
  start: string;
  end: string;
  stage: string;
  durationMin: number;
}

interface SleepRow {
  date: string;
  bedtime: string;
  wakeup: string;
  totalMin: number;
  deepMin: number;
  coreMin: number;
  remMin: number;
  awakeMin: number;
  fragments: number;
  stages: SleepStageRow[];
}

let sheetsAccount: GoogleAccount | null = null;
let sheetIdPath = "";

export function initSleepSheet(account: GoogleAccount, workspaceDir: string): void {
  sheetsAccount = account;
  sheetIdPath = resolve(workspaceDir, "sleep", "sheet-id.txt");
}

/** Append a night's summary + raw stages to the Google Sheet. */
export async function appendSleepToSheet(row: SleepRow): Promise<string> {
  if (!sheetsAccount) return "Sleep sheet not initialized";

  const spreadsheetId = await getOrCreateSheet();
  const sheets = google.sheets({ version: "v4", auth: sheetsAccount!.auth });

  // ── Summary sheet ──
  const summaryValues = [[
    row.date,
    row.bedtime,
    row.wakeup,
    `${Math.floor(row.totalMin / 60)}h${row.totalMin % 60}m`,
    String(row.deepMin),
    String(row.coreMin),
    String(row.remMin),
    String(row.awakeMin),
    String(row.fragments),
  ]];

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SUMMARY_SHEET}!A:A`,
  });

  const rows = existing.data.values ?? [];
  const dateExists = rows.some((r) => r[0] === row.date);

  if (dateExists) {
    const rowIdx = rows.findIndex((r) => r[0] === row.date);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SUMMARY_SHEET}!A${rowIdx + 1}:I${rowIdx + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: summaryValues },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SUMMARY_SHEET}!A:I`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: summaryValues },
    });
  }

  // ── Raw Data sheet ──
  // Delete existing rows for this date, then append fresh
  const existingRaw = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RAW_SHEET}!A:A`,
  });

  const rawRows = existingRaw.data.values ?? [];
  // Find row range to clear (skip header at index 0)
  let clearStart = -1;
  let clearEnd = -1;
  for (let i = 1; i < rawRows.length; i++) {
    if (rawRows[i]?.[0] === row.date) {
      if (clearStart === -1) clearStart = i + 1; // 1-indexed
      clearEnd = i + 1;
    }
  }

  if (clearStart !== -1) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${RAW_SHEET}!A${clearStart}:E${clearEnd}`,
    });
  }

  // Append raw stage rows
  const rawValues = row.stages.map((s) => [
    row.date,
    s.start,
    s.end,
    s.stage,
    String(s.durationMin),
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${RAW_SHEET}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rawValues },
  });

  const action = dateExists ? "Updated" : "Added";
  return `${action} ${row.date} in sleep sheet (${row.stages.length} stages)`;
}

async function getOrCreateSheet(): Promise<string> {
  if (existsSync(sheetIdPath)) {
    const id = readFileSync(sheetIdPath, "utf-8").trim();
    if (id) return id;
  }

  const sheets = google.sheets({ version: "v4", auth: sheetsAccount!.auth! });

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: SHEET_TITLE },
      sheets: [
        { properties: { title: SUMMARY_SHEET } },
        { properties: { title: RAW_SHEET } },
      ],
    },
  });

  const spreadsheetId = res.data.spreadsheetId!;
  const summarySheetId = res.data.sheets?.[0]?.properties?.sheetId ?? 0;
  const rawSheetId = res.data.sheets?.[1]?.properties?.sheetId ?? 1;

  // Add headers to both sheets
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: `${SUMMARY_SHEET}!A1:I1`, values: [SUMMARY_HEADER] },
        { range: `${RAW_SHEET}!A1:E1`, values: [RAW_HEADER] },
      ],
    },
  });

  // Bold headers + freeze first row on both sheets
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: summarySheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: summarySheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId: rawSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId: rawSheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  writeFileSync(sheetIdPath, spreadsheetId);
  console.log(`[sleep-sheet] Created: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

  return spreadsheetId;
}
