import type { FunctionDeclaration } from "@google/generative-ai";
import type Database from "better-sqlite3";
import type { MarkdownMemory } from "../memory/markdown.js";
import type { GoogleAccount } from "../services/google-auth.js";

export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

export interface ToolContext {
  db: Database.Database;
  memory: MarkdownMemory;
  profilesDir: string;
  googleAccounts: GoogleAccount[];
  amadeusClientId: string;
  amadeusClientSecret: string;
}

/**
 * A Skill is a self-contained module that provides tools to the agent.
 *
 * To create a new skill:
 * 1. Create a .ts file in src/skills/
 * 2. Export a Skill object with name, description, tools, and createHandlers
 * 3. Register it in src/index.ts: registry.register(mySkill)
 */
export interface Skill {
  /** Unique skill name */
  name: string;
  /** What this skill does — shown to the model for planning */
  description: string;
  /** Tool declarations for the LLM */
  tools: FunctionDeclaration[];
  /** Create tool handlers bound to the given context */
  createHandlers(ctx: ToolContext): Record<string, ToolHandler>;
}
