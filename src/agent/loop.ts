import {
  GoogleGenerativeAI,
  type Part,
} from "@google/generative-ai";
import type { Config } from "../config.js";
import type { ToolContext } from "../skills/types.js";
import type { SkillRegistry } from "../skills/registry.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  getHistory, addToHistory, needsFlush,
  triggerFlush, pruneToolResults, setFlushCallback,
} from "./history.js";
import type { MarkdownMemory } from "../memory/markdown.js";

export interface AgentDeps {
  config: Config;
  toolCtx: ToolContext;
  memory: MarkdownMemory;
  registry: SkillRegistry;
}

export type StreamCallback = (chunk: string) => void;

// Cache Gemini client (rebuilt only when API key changes)
let cachedGenAI: GoogleGenerativeAI | null = null;
let cachedApiKey = "";

export async function backgroundFlush(): Promise<void> {
  if (!needsFlush()) return;
  try {
    await triggerFlush();
  } catch (e) {
    console.log(`[flush] Error: ${(e as Error).message}`);
  }
}

export function initFlushCallback(deps: AgentDeps): void {
  setFlushCallback(async () => {
    console.log("[flush] Triggering pre-compaction memory flush");
    const flushPrompt = "Your conversation history is getting long and will be trimmed soon. " +
      "Review the conversation and use memory_save to save any important facts, decisions, " +
      "or context that should be remembered. Do this now silently.";
    await agentLoop(deps, flushPrompt, deps.config.models.fast);
  });
}

export async function transcribeAudio(
  deps: AgentDeps,
  audio: Buffer,
): Promise<string> {
  const t0 = performance.now();
  const genai = new GoogleGenerativeAI(deps.config.geminiApiKey);
  const model = genai.getGenerativeModel({
    model: deps.config.models.fast,
  });

  const result = await model.generateContent([
    { text: "Transcribe this audio exactly. Reply with ONLY the transcription text, nothing else." },
    { inlineData: { mimeType: "audio/ogg", data: audio.toString("base64") } },
  ]);

  const text = result.response.text() || "(could not transcribe)";
  console.log(`[perf] STT: ${(performance.now() - t0).toFixed(0)}ms | "${text.slice(0, 80)}"`);
  return text;
}

export async function agentLoop(
  deps: AgentDeps,
  userMessage: string,
  model?: string,
  audio?: Buffer,
  onStream?: StreamCallback,
): Promise<string> {
  const t0 = performance.now();
  const { config, toolCtx, memory, registry } = deps;
  const handlers = registry.createHandlers(toolCtx);
  const usedModel = model ?? config.models.fast;

  // Reuse Gemini client across calls
  if (!cachedGenAI || cachedApiKey !== config.geminiApiKey) {
    cachedGenAI = new GoogleGenerativeAI(config.geminiApiKey);
    cachedApiKey = config.geminiApiKey;
  }

  pruneToolResults();

  const sysPrompt = buildSystemPrompt(memory, registry);
  const genModel = cachedGenAI!.getGenerativeModel({
    model: usedModel,
    systemInstruction: sysPrompt,
    tools: [{ functionDeclarations: registry.getToolDeclarations() }],
  });

  const messageParts: Part[] = [{ text: userMessage }];
  if (audio) {
    messageParts.push({
      inlineData: { mimeType: "audio/ogg", data: audio.toString("base64") },
    });
  }

  addToHistory({ role: "user", parts: messageParts });

  const priorHistory = getHistory().slice(0, -1);
  const chat = genModel.startChat({ history: priorHistory });

  console.log(`[perf] setup: ${(performance.now() - t0).toFixed(0)}ms | model=${usedModel} | history=${priorHistory.length}`);

  // Use streaming if callback provided
  let result: string;
  if (onStream) {
    result = await streamingLoop(chat, messageParts, handlers, config.maxAgentIterations, onStream);
  } else {
    result = await standardLoop(chat, messageParts, handlers, config.maxAgentIterations);
  }

  console.log(`[perf] agentLoop total: ${(performance.now() - t0).toFixed(0)}ms | model=${usedModel}`);
  return result;
}

async function standardLoop(
  chat: ReturnType<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["startChat"]>,
  messageParts: Part[],
  handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
  maxIterations: number,
): Promise<string> {
  let gt = performance.now();
  let response = await chat.sendMessage(messageParts);
  console.log(`[perf] gemini initial: ${(performance.now() - gt).toFixed(0)}ms`);
  let iterations = 0;

  while (iterations++ < maxIterations) {
    const candidate = response.response.candidates?.[0];
    const parts = candidate?.content?.parts;
    if (!parts || parts.length === 0) {
      console.log(`[agent] Empty response. finishReason=${candidate?.finishReason ?? "unknown"}`);
      if (iterations === 1) {
        return "The model returned an empty response. Please try rephrasing.";
      }
      gt = performance.now();
      response = await chat.sendMessage([{ text: "Please summarize your findings and respond." }]);
      console.log(`[perf] gemini nudge: ${(performance.now() - gt).toFixed(0)}ms`);
      continue;
    }

    const fnCalls = extractFunctionCalls(parts);
    if (fnCalls.length === 0) {
      const text = extractText(parts);
      addToHistory({ role: "model", parts: [{ text }] });
      return text;
    }

    const tt = performance.now();
    const fnResponses = await executeTools(handlers, fnCalls);
    console.log(`[perf] tools (${fnCalls.map((c) => c.name).join(",")}): ${(performance.now() - tt).toFixed(0)}ms`);

    gt = performance.now();
    response = await chat.sendMessage(fnResponses);
    console.log(`[perf] gemini iter${iterations}: ${(performance.now() - gt).toFixed(0)}ms`);
  }

  return "Reached maximum iterations. Please try a simpler request.";
}

async function streamingLoop(
  chat: ReturnType<ReturnType<GoogleGenerativeAI["getGenerativeModel"]>["startChat"]>,
  messageParts: Part[],
  handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
  maxIterations: number,
  onStream: StreamCallback,
): Promise<string> {
  let gt = performance.now();
  let streamResult = await chat.sendMessageStream(messageParts);
  let iterations = 0;

  while (iterations++ < maxIterations) {
    let fullText = "";
    let fnCalls: { name: string; args: Record<string, unknown> }[] = [];

    for await (const chunk of streamResult.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts;
      if (!parts) continue;

      for (const part of parts) {
        if (part.text) {
          fullText += part.text;
          onStream(fullText);
        }
        if (part.functionCall) {
          fnCalls.push({
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          });
        }
      }
    }

    console.log(`[perf] gemini stream iter${iterations}: ${(performance.now() - gt).toFixed(0)}ms`);

    if (fnCalls.length === 0) {
      if (!fullText && iterations > 1) {
        gt = performance.now();
        streamResult = await chat.sendMessageStream([{ text: "Please summarize your findings and respond." }]);
        continue;
      }
      addToHistory({ role: "model", parts: [{ text: fullText }] });
      return fullText;
    }

    // Execute tools in parallel, stream status
    const toolNames = fnCalls.map((c) => c.name).join(", ");
    onStream(fullText + `\n_Using: ${toolNames}..._`);
    const tt = performance.now();
    const fnResponses = await executeTools(handlers, fnCalls);
    console.log(`[perf] tools (${toolNames}): ${(performance.now() - tt).toFixed(0)}ms`);

    gt = performance.now();
    streamResult = await chat.sendMessageStream(fnResponses);
    fnCalls = [];
  }

  return "Reached maximum iterations.";
}

function extractFunctionCalls(parts: Part[]): { name: string; args: Record<string, unknown> }[] {
  return parts
    .filter((p) => p.functionCall !== undefined)
    .map((p) => ({
      name: p.functionCall!.name,
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
    }));
}

async function executeTools(
  handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
  fnCalls: { name: string; args: Record<string, unknown> }[],
): Promise<Part[]> {
  // Execute all tool calls in parallel
  const results = await Promise.all(
    fnCalls.map(async (call) => {
      const result = await executeTool(handlers, call.name, call.args);
      return { name: call.name, result };
    }),
  );
  return results.map((r) => ({
    functionResponse: { name: r.name, response: { result: r.result } },
  }));
}

async function executeTool(
  handlers: Record<string, (args: Record<string, unknown>) => string | Promise<string>>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = handlers[name];
  if (!handler) return `Unknown tool: ${name}`;
  try {
    return await handler(args);
  } catch (e) {
    const err = e as Error;
    return `Tool error: ${err.message}`;
  }
}

function extractText(parts: Part[]): string {
  const texts = parts.filter((p) => p.text).map((p) => p.text);
  return texts.join("") || "(empty response)";
}

// Model routing: Flash for most tasks, Pro only for complex reasoning
export function routeModel(message: string, config: Config): string {
  const msg = message.toLowerCase();
  // Pro only for long-form composition or multi-step analysis
  const needsSmart = (msg.includes("draft") && msg.includes("email"))
    || msg.includes("analyze in detail")
    || msg.includes("write a ")
    || msg.includes("compare and recommend")
    || msg.length > 500;
  return needsSmart ? config.models.smart : config.models.fast;
}
