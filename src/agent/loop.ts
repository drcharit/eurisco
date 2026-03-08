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

const REFLECT_PROMPT =
  "Silently analyze the last conversation turn. Extract any new insights about Charit and save them using memory_save. " +
  "Categories to look for:\n" +
  "- TRAVEL: destinations, dates, plans, preferences (airlines, hotels, class)\n" +
  "- INTERESTS: topics, hobbies, things he's curious about\n" +
  "- WORK: projects, colleagues, decisions, deadlines\n" +
  "- HEALTH: medical, fitness, diet mentions\n" +
  "- PEOPLE: relationships, who he's meeting, context about contacts\n" +
  "- PREFERENCES: communication style, tools, food, schedule habits\n" +
  "- PLANS: upcoming events, goals, intentions\n\n" +
  "Format each insight as: [CATEGORY] insight text\n" +
  "Only save genuinely NEW information — skip if nothing new was learned. " +
  "Do NOT repeat things already in memory. Do NOT respond to the user.";

// Guard against re-entrant agentLoop calls (reflect/flush calling agentLoop)
let internalCall = false;

export async function reflect(deps: AgentDeps): Promise<void> {
  const history = getHistory();
  if (history.length < 2) return;

  try {
    console.log("[reflect] Analyzing conversation for insights...");
    internalCall = true;
    await agentLoop(deps, REFLECT_PROMPT, deps.config.models.fast);
    console.log("[reflect] Done");
  } catch (e) {
    const err = e as Error;
    console.log(`[reflect] Error: ${err.message}`);
  } finally {
    internalCall = false;
  }
}

export async function backgroundFlush(_deps: AgentDeps): Promise<void> {
  if (!needsFlush()) return;
  try {
    console.log("[flush] Background memory flush...");
    internalCall = true;
    await triggerFlush();
    console.log("[flush] Done");
  } catch (e) {
    const err = e as Error;
    console.log(`[flush] Error: ${err.message}`);
  } finally {
    internalCall = false;
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
  const genai = new GoogleGenerativeAI(config.geminiApiKey);
  const usedModel = model ?? config.models.smart;

  // Skip flush/reflect re-entrancy
  if (internalCall) {
    // Already inside a reflect/flush call — just proceed without nesting
  }

  // Prune old tool results to save context
  const pt = performance.now();
  pruneToolResults();
  const pruneMs = performance.now() - pt;
  if (pruneMs > 1) console.log(`[perf] prune: ${pruneMs.toFixed(0)}ms`);

  const st = performance.now();
  const sysPrompt = buildSystemPrompt(memory, registry);
  console.log(`[perf] buildPrompt: ${(performance.now() - st).toFixed(0)}ms`);

  const genModel = genai.getGenerativeModel({
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

  // Add user message to history
  addToHistory({ role: "user", parts: messageParts });

  // Start chat with prior history (exclude current message)
  const ht = performance.now();
  const priorHistory = getHistory().slice(0, -1);
  console.log(`[perf] history prep: ${(performance.now() - ht).toFixed(0)}ms (${priorHistory.length} entries)`);

  const chat = genModel.startChat({ history: priorHistory });

  console.log(`[perf] setup total: ${(performance.now() - t0).toFixed(0)}ms | model=${usedModel}`);

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

    // Execute tools, stream status
    const toolNames = fnCalls.map((c) => c.name).join(", ");
    onStream(fullText + `\n_Using: ${toolNames}..._`);
    const tt = performance.now();
    const fnResponses: Part[] = [];
    for (const call of fnCalls) {
      const toolT = performance.now();
      const result = await executeTool(handlers, call.name, call.args);
      console.log(`[perf]   tool ${call.name}: ${(performance.now() - toolT).toFixed(0)}ms`);
      fnResponses.push({
        functionResponse: { name: call.name, response: { result } },
      });
    }
    console.log(`[perf] tools total: ${(performance.now() - tt).toFixed(0)}ms`);

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
  const results: Part[] = [];
  for (const call of fnCalls) {
    const result = await executeTool(handlers, call.name, call.args);
    results.push({
      functionResponse: { name: call.name, response: { result } },
    });
  }
  return results;
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

// Model routing: use smart for complex multi-step tasks
export function routeModel(message: string, config: Config): string {
  const msg = message.toLowerCase();
  const needsSmart = msg.includes("analyze") || msg.includes("compare")
    || msg.includes("explain") || msg.includes("draft")
    || msg.includes("write") || msg.includes("plan")
    || msg.length > 300;
  return needsSmart ? config.models.smart : config.models.fast;
}
