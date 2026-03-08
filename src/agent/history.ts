import type { Content } from "@google/generative-ai";
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const MAX_HISTORY = 80;
const FLUSH_THRESHOLD = 60;

let history: Content[] = [];
let historyPath = "";
let flushCallback: (() => Promise<void>) | null = null;

export function initHistory(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  historyPath = resolve(dataDir, "conversation.jsonl");
  history = loadFromDisk();
  console.log(`[history] Loaded ${history.length} entries from disk`);
}

export function setFlushCallback(cb: () => Promise<void>): void {
  flushCallback = cb;
}

export function getHistory(): Content[] {
  // Gemini requires history to start with role 'user'
  let start = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i]!.role === "user") {
      start = i;
      break;
    }
    start = i + 1;
  }
  return history.slice(start);
}

export function needsFlush(): boolean {
  return history.length >= FLUSH_THRESHOLD && flushCallback !== null;
}

export async function triggerFlush(): Promise<void> {
  if (flushCallback) {
    await flushCallback();
  }
}

export function addToHistory(entry: Content): void {
  history.push(entry);
  appendToDisk(entry);

  // Hard limit: trim oldest entries after flush threshold is well past
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  // Rewrite file if we trimmed
  if (history.length === MAX_HISTORY) {
    rewriteDisk();
  }
}

export function clearHistory(): void {
  history = [];
  if (historyPath) {
    writeFileSync(historyPath, "");
  }
}

export function pruneToolResults(): void {
  const MAX_TOOL_AGE = 10;
  const MAX_TOOL_LEN = 500;
  const len = history.length;

  for (let i = 0; i < len - MAX_TOOL_AGE; i++) {
    const entry = history[i];
    if (!entry) continue;
    for (const part of entry.parts) {
      if ("functionResponse" in part && part.functionResponse) {
        const resp = part.functionResponse.response as { result?: string };
        if (resp.result && resp.result.length > MAX_TOOL_LEN) {
          resp.result = resp.result.slice(0, MAX_TOOL_LEN) + "\n...(pruned)";
        }
      }
    }
  }
}

function loadFromDisk(): Content[] {
  if (!historyPath || !existsSync(historyPath)) return [];
  const lines = readFileSync(historyPath, "utf-8").split("\n").filter(Boolean);
  const entries: Content[] = [];
  const MAX_LOAD = 100;

  for (let i = 0; i < MAX_LOAD && i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]!) as Content);
    } catch {
      continue;
    }
  }

  // Only keep last MAX_HISTORY
  return entries.slice(-MAX_HISTORY);
}

function appendToDisk(entry: Content): void {
  if (!historyPath) return;
  appendFileSync(historyPath, JSON.stringify(entry) + "\n");
}

function rewriteDisk(): void {
  if (!historyPath) return;
  const data = history.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(historyPath, data);
}
