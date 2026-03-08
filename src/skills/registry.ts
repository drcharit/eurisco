import type { FunctionDeclaration } from "@google/generative-ai";
import type { Skill, ToolContext, ToolHandler } from "./types.js";

export class SkillRegistry {
  private skills: Skill[] = [];

  register(skill: Skill): void {
    this.skills.push(skill);
  }

  getToolDeclarations(): FunctionDeclaration[] {
    return this.skills.flatMap((s) => s.tools);
  }

  createHandlers(ctx: ToolContext): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    for (const skill of this.skills) {
      Object.assign(handlers, skill.createHandlers(ctx));
    }
    return handlers;
  }

  /** Generate a manifest of available skills for the system prompt */
  getManifest(): string {
    return this.skills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
  }

  get count(): number {
    return this.skills.length;
  }
}
