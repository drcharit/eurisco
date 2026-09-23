/**
 * Training skill — query workouts, view metrics, trigger sync.
 */

import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext } from "./types.js";
import type {} from "../services/strava.js";

const S = SchemaType;

export const trainingSkill: Skill = {
  name: "training",
  description:
    "Query Strava workouts, view training metrics and weekly summaries, trigger manual sync.",

  tools: [
    {
      name: "workout_log",
      description: "View recent workouts. Filter by type (Run, Walk, Intervals, etc) or number of days.",
      parameters: {
        type: S.OBJECT,
        properties: {
          days: { type: S.INTEGER, description: "Look back N days (default 7)" },
          type: { type: S.STRING, description: "Filter by workout type (Run, Intervals, Tempo Run, Long Run, etc)" },
        },
        required: [],
      },
    },
    {
      name: "training_summary",
      description: "Weekly training summary — total distance, sessions, avg pace, HR trends.",
      parameters: {
        type: S.OBJECT,
        properties: {
          weeks: { type: S.INTEGER, description: "Number of weeks to summarize (default 4)" },
        },
        required: [],
      },
    },
    {
      name: "strava_sync",
      description: "Manually trigger a Strava sync to fetch latest workouts.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
  ] as FunctionDeclaration[],

  createHandlers(ctx: ToolContext) {
    return {
      workout_log: (args: Record<string, unknown>) => {
        const days = (args["days"] as number) ?? 7;
        const type = args["type"] as string | undefined;

        let query = "SELECT date, name, workout_type, distance_km, pace_per_km, moving_time_sec, avg_heartrate, max_heartrate, hr_zones_json FROM workouts WHERE date >= date('now', ?)";
        const params: unknown[] = [`-${days} days`];

        if (type) {
          query += " AND (workout_type LIKE ? OR strava_type LIKE ?)";
          params.push(`%${type}%`, `%${type}%`);
        }
        query += " ORDER BY date DESC LIMIT 20";

        const rows = ctx.db.prepare(query).all(...params) as Array<{
          date: string; name: string; workout_type: string; distance_km: number;
          pace_per_km: string; moving_time_sec: number; avg_heartrate: number | null;
          max_heartrate: number | null; hr_zones_json: string | null;
        }>;

        if (rows.length === 0) return `No workouts found in the last ${days} days.`;

        return rows.map((r) => {
          const dur = `${Math.floor(r.moving_time_sec / 60)}m`;
          const hr = r.avg_heartrate ? `HR:${Math.round(r.avg_heartrate)}` : "";
          const zones = r.hr_zones_json ? ` ${formatZones(r.hr_zones_json)}` : "";
          return `${r.date} | ${r.workout_type} | ${r.name} | ${r.distance_km.toFixed(1)}km | ${r.pace_per_km}/km | ${dur} | ${hr}${zones}`;
        }).join("\n");
      },

      training_summary: (args: Record<string, unknown>) => {
        const weeks = (args["weeks"] as number) ?? 4;
        const rows = ctx.db.prepare(`
          SELECT
            strftime('%Y-W%W', date) as week,
            COUNT(*) as sessions,
            SUM(CASE WHEN strava_type = 'Run' THEN distance_km ELSE 0 END) as run_km,
            AVG(CASE WHEN strava_type = 'Run' THEN pace_decimal ELSE NULL END) as avg_pace,
            AVG(CASE WHEN strava_type = 'Run' THEN avg_heartrate ELSE NULL END) as avg_hr,
            MAX(CASE WHEN strava_type = 'Run' THEN distance_km ELSE 0 END) as longest_run
          FROM workouts
          WHERE date >= date('now', ?)
          GROUP BY week
          ORDER BY week DESC
        `).all(`-${weeks * 7} days`) as Array<{
          week: string; sessions: number; run_km: number;
          avg_pace: number | null; avg_hr: number | null; longest_run: number;
        }>;

        if (rows.length === 0) return "No training data found.";

        const lines = rows.map((r) => {
          const pace = r.avg_pace ? `${Math.floor(r.avg_pace)}:${Math.round((r.avg_pace % 1) * 60).toString().padStart(2, "0")}/km` : "—";
          const hr = r.avg_hr ? `HR:${Math.round(r.avg_hr)}` : "";
          return `${r.week} | ${r.sessions} sessions | ${r.run_km.toFixed(1)}km running | pace ${pace} | ${hr} | longest: ${r.longest_run.toFixed(1)}km`;
        });

        const totalRuns = rows.reduce((s, r) => s + r.run_km, 0);
        lines.push(`\nTotal: ${totalRuns.toFixed(1)}km across ${rows.reduce((s, r) => s + r.sessions, 0)} sessions`);

        return lines.join("\n");
      },

      strava_sync: () => {
        return "Strava sync runs automatically every 2 hours. Check pm2 logs for sync status. Use workout_log to see latest activities.";
      },
    };
  },
};

function formatZones(json: string): string {
  try {
    const z = JSON.parse(json) as Record<string, number>;
    return `Z1:${z["Z1"] ?? 0}% Z2:${z["Z2"] ?? 0}% Z3:${z["Z3"] ?? 0}% Z4:${z["Z4"] ?? 0}% Z5:${z["Z5"] ?? 0}%`;
  } catch {
    return "";
  }
}
