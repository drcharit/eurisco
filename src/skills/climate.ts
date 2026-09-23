import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext } from "./types.js";
import { acOn, acOff, acStatus } from "../services/ac.js";
import {
  acSchedulerSkip,
  acSchedulerPause,
  acSchedulerResume,
  acSchedulerState,
  acSchedulerProfile,
  acSchedulerSetProfile,
  acSchedulerListProfiles,
} from "../services/ac-scheduler.js";

const S = SchemaType;

export const climateSkill: Skill = {
  name: "climate",
  description:
    "Control the bedroom air conditioner — turn on/off, adjust temperature, " +
    "fan speed, and mode. Manage the night schedule (skip/pause/resume/profiles).",

  tools: [
    {
      name: "ac_on",
      description:
        "Turn AC on with specified settings. Defaults: 24°C, cool mode, fan low.",
      parameters: {
        type: S.OBJECT,
        properties: {
          temp: { type: S.INTEGER, description: "Temperature 16-30°C (default 24)" },
          mode: { type: S.INTEGER, description: "0=cool 1=heat 2=auto 3=fan 4=dehumidify (default 0)" },
          fan: { type: S.INTEGER, description: "0=auto 1=low 2=medium 3=high (default 1)" },
        },
        required: [],
      },
    },
    {
      name: "ac_off",
      description: "Turn AC off.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
    {
      name: "ac_status",
      description: "Get current AC status — power, temperature, mode, fan speed, schedule state and profile.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
    {
      name: "ac_skip",
      description: "Skip the AC night schedule for tonight only. Resumes automatically tomorrow.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
    {
      name: "ac_pause",
      description: "Pause the AC night schedule indefinitely. Use when travelling or away from home.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
    {
      name: "ac_resume",
      description: "Resume the AC night schedule after a pause.",
      parameters: { type: S.OBJECT, properties: {}, required: [] },
    },
    {
      name: "ac_profile",
      description:
        "Switch AC night schedule profile or list available profiles. " +
        "Profiles: default, summer, mild, fan_only. Call with no args to list all.",
      parameters: {
        type: S.OBJECT,
        properties: {
          name: { type: S.STRING, description: "Profile name to switch to (omit to list all)" },
        },
        required: [],
      },
    },
  ] as FunctionDeclaration[],

  createHandlers(ctx: ToolContext) {
    return {
      ac_on: (args: Record<string, unknown>) =>
        acOn(
          ctx.acCredentials,
          (args["temp"] as number) ?? 24,
          (args["mode"] as number) ?? 0,
          (args["fan"] as number) ?? 1,
        ),
      ac_off: () => acOff(ctx.acCredentials),
      ac_status: async () => {
        const status = await acStatus(ctx.acCredentials);
        return `${status}\nSchedule: ${acSchedulerState()}\nProfile: ${acSchedulerProfile()}`;
      },
      ac_skip: () => acSchedulerSkip(),
      ac_pause: () => acSchedulerPause(),
      ac_resume: () => acSchedulerResume(),
      ac_profile: (args: Record<string, unknown>) => {
        const name = args["name"] as string | undefined;
        if (!name) return acSchedulerListProfiles();
        return acSchedulerSetProfile(name);
      },
    };
  },
};
