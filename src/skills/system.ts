import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { Skill } from "./types.js";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const S = SchemaType;

export const systemSkill: Skill = {
  name: "system",
  description:
    "Run shell commands, read and write files. Use for system tasks, " +
    "checking status, managing files on the host machine.",

  tools: [
    {
      name: "exec",
      description: "Run a shell command and return output.",
      parameters: {
        type: S.OBJECT,
        properties: { command: { type: S.STRING, description: "Shell command" } },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read contents of a file.",
      parameters: {
        type: S.OBJECT,
        properties: { path: { type: S.STRING, description: "Absolute file path" } },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file (creates or overwrites).",
      parameters: {
        type: S.OBJECT,
        properties: {
          path: { type: S.STRING, description: "Absolute file path" },
          content: { type: S.STRING, description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  ] as FunctionDeclaration[],

  createHandlers() {
    return {
      exec: (args: Record<string, unknown>) => {
        const command = args["command"] as string;
        try {
          const output = execSync(command, {
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
          });
          return output.slice(0, 4000);
        } catch (e) {
          const err = e as { stderr?: string; message: string };
          return `Error: ${err.stderr ?? err.message}`.slice(0, 2000);
        }
      },

      read_file: (args: Record<string, unknown>) => {
        const path = args["path"] as string;
        if (!existsSync(path)) return `File not found: ${path}`;
        const content = readFileSync(path, "utf-8");
        if (content.length > 8000) {
          return content.slice(0, 8000) + "\n... (truncated)";
        }
        return content;
      },

      write_file: (args: Record<string, unknown>) => {
        const path = args["path"] as string;
        const content = args["content"] as string;
        writeFileSync(path, content);
        return `Written ${content.length} bytes to ${path}`;
      },
    };
  },
};
