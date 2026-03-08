import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";

export class MarkdownMemory {
  private readonly workspaceDir: string;
  private readonly memoryDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.memoryDir = resolve(workspaceDir, "memory");
    mkdirSync(this.memoryDir, { recursive: true });
  }

  readSoul(): string {
    return this.readFile("SOUL.md");
  }

  readLongTermMemory(): string {
    return this.readFile("MEMORY.md");
  }

  readDailyLog(date: string): string {
    return this.readFile(join("memory", `${date}.md`));
  }

  todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  readToday(): string {
    return this.readDailyLog(this.todayDate());
  }

  readYesterday(): string {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return this.readDailyLog(d.toISOString().slice(0, 10));
  }

  appendToDaily(content: string, date?: string): void {
    const target = date ?? this.todayDate();
    const filePath = resolve(this.memoryDir, `${target}.md`);
    const timestamp = new Date().toLocaleTimeString("en-IN", { hour12: false });
    appendFileSync(filePath, `\n### ${timestamp}\n${content}\n`);
  }

  saveLongTermMemory(content: string): void {
    writeFileSync(resolve(this.workspaceDir, "MEMORY.md"), content);
  }

  private readFile(relPath: string): string {
    const full = resolve(this.workspaceDir, relPath);
    if (!existsSync(full)) return "";
    return readFileSync(full, "utf-8");
  }
}
