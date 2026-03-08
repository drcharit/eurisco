import { Bot } from "grammy";
import type { Config } from "../config.js";
import type { AgentDeps } from "../agent/loop.js";
import { agentLoop, routeModel, reflect, backgroundFlush, transcribeAudio } from "../agent/loop.js";
import { clearHistory } from "../agent/history.js";
import { downloadVoice } from "./voice.js";

const DEBOUNCE_MS = 1500;
const STREAM_UPDATE_MS = 1000;

export function createBot(config: Config, agentDeps: AgentDeps): Bot {
  const bot = new Bot(config.telegramBotToken);

  // Message queue to prevent concurrent agent loops
  let processing = false;
  const queue: (() => Promise<void>)[] = [];

  async function processQueue(): Promise<void> {
    if (processing) return;
    const next = queue.shift();
    if (!next) return;
    processing = true;
    try {
      await next();
    } finally {
      processing = false;
      processQueue();
    }
  }

  function enqueue(task: () => Promise<void>): void {
    queue.push(task);
    processQueue();
  }

  // Debounce: batch rapid messages
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingText = "";
  let pendingChatId = 0;

  bot.command("start", (ctx) => ctx.reply("Kit is online. Eurisco at your service."));

  bot.command("clear", (ctx) => {
    clearHistory();
    ctx.reply("Conversation cleared.");
  });

  bot.on("message:text", (ctx) => {
    if (!isOwner(ctx.from?.id, config.telegramOwnerId)) return;

    const chatId = ctx.chat.id;

    // Accumulate text for debouncing
    if (pendingChatId === chatId && debounceTimer) {
      pendingText += "\n" + ctx.message.text;
    } else {
      pendingText = ctx.message.text;
      pendingChatId = chatId;
    }

    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      const text = pendingText;
      pendingText = "";
      debounceTimer = null;

      enqueue(async () => {
        const turnStart = performance.now();
        const model = routeModel(text, config);
        const status = await ctx.reply("Working...");
        let lastUpdate = 0;

        try {
          const reply = await agentLoop(agentDeps, text, model, undefined, (chunk) => {
            // Stream updates: edit the "Working..." message periodically
            const now = Date.now();
            if (now - lastUpdate > STREAM_UPDATE_MS && chunk.length > 0) {
              lastUpdate = now;
              const preview = chunk.length > 4000 ? chunk.slice(-4000) : chunk;
              ctx.api.editMessageText(chatId, status.message_id, preview).catch(() => {});
            }
          });

          // Final update with complete response
          await ctx.api.deleteMessage(chatId, status.message_id).catch(() => {});
          await sendChunked(ctx, reply);

          console.log(`[perf] TURN TOTAL: ${(performance.now() - turnStart).toFixed(0)}ms | len=${reply.length}`);

          // Background tasks — don't block the user
          backgroundFlush(agentDeps).catch(() => {});
          reflect(agentDeps).catch(() => {});
        } catch (e) {
          const err = e as Error;
          await ctx.api.deleteMessage(chatId, status.message_id).catch(() => {});
          await ctx.reply(`Error: ${err.message.slice(0, 200)}`);
        }
      });
    }, DEBOUNCE_MS);
  });

  bot.on(["message:voice", "message:audio"], (ctx) => {
    if (!isOwner(ctx.from?.id, config.telegramOwnerId)) return;

    enqueue(async () => {
      const status = await ctx.reply("Working...");

      try {
        const file = await ctx.getFile();
        const t0 = performance.now();
        const audioBuffer = await downloadVoice(file, config.telegramBotToken);
        console.log(`[perf] voice download: ${(performance.now() - t0).toFixed(0)}ms`);

        // Step 1: Transcribe with Flash (no tools, no history — pure STT)
        const transcription = await transcribeAudio(agentDeps, audioBuffer);

        // Show transcription immediately so user knows we understood
        await ctx.api.editMessageText(
          ctx.chat.id, status.message_id,
          `_${transcription}_\n\nWorking...`
        ).catch(() => {});

        // Step 2: Route transcribed text to the right model
        const model = routeModel(transcription, config);
        const prompt = `The user said (via voice): "${transcription}"\n\nRespond to their request.`;

        const t2 = performance.now();
        let lastUpdate = 0;
        const reply = await agentLoop(agentDeps, prompt, model, undefined, (chunk) => {
          const now = Date.now();
          if (now - lastUpdate > STREAM_UPDATE_MS && chunk.length > 0) {
            lastUpdate = now;
            const preview = chunk.length > 4000 ? chunk.slice(-4000) : chunk;
            ctx.api.editMessageText(ctx.chat.id, status.message_id, preview).catch(() => {});
          }
        });
        console.log(`[perf] voice response: ${(performance.now() - t2).toFixed(0)}ms | model=${model}`);

        await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
        // Include transcription in the final response
        await sendChunked(ctx, `_${transcription}_\n\n${reply}`);

        // Background tasks
        backgroundFlush(agentDeps).catch(() => {});
        reflect(agentDeps).catch(() => {});
      } catch (e) {
        const err = e as Error;
        await ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
        await ctx.reply(`Error processing audio: ${err.message.slice(0, 200)}`);
      }
    });
  });

  return bot;
}

function isOwner(fromId: number | undefined, ownerId: number): boolean {
  return fromId === ownerId;
}

async function sendChunked(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string
): Promise<void> {
  const MAX_LEN = 4096;
  if (text.length <= MAX_LEN) {
    await sendWithFallback(ctx, text);
    return;
  }

  const chunks = splitText(text, MAX_LEN);
  for (const chunk of chunks) {
    await sendWithFallback(ctx, chunk);
  }
}

async function sendWithFallback(
  ctx: { reply: (text: string, options?: Record<string, unknown>) => Promise<unknown> },
  text: string
): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(text);
  }
}

function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  const MAX_CHUNKS = 10;

  for (let i = 0; i < MAX_CHUNKS && remaining.length > 0; i++) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const breakPoint = remaining.lastIndexOf("\n", maxLen);
    const splitAt = breakPoint > maxLen * 0.5 ? breakPoint : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
