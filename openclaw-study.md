# OpenClaw Codebase Study — Building Eurisco from Scratch

## Executive Summary

OpenClaw is a 1.4GB Node.js application with 10,592 dependencies. But its essential architecture is surprisingly simple — a **while loop calling an LLM API with tools**. The rest is scaffolding for multi-channel, multi-user, multi-provider support we don't need.

**Eurisco can replicate OpenClaw's core value in ~500 lines of code and ~50MB of dependencies.**

---

## What OpenClaw Actually Does (stripped to essentials)

```
Message arrives (Telegram)
  → Auth check (is this my user?)
  → Load session history (JSONL file)
  → Build system prompt (SOUL.md + tools + memory)
  → while true:
      Call Claude API with messages + tools
      if stop_reason == "end_turn": break
      if stop_reason == "tool_use": execute tools, append results
  → Send response to Telegram
  → Append turn to JSONL
```

That's it. Everything else is optimization.

---

## Component-by-Component: What to Build vs Skip

### 1. GATEWAY & ENTRY POINT

**OpenClaw**: WebSocket server on port 18789, multi-subsystem attachment, file watchers, config validation with Zod, hot-reload.

**Eurisco needs**: A single Node.js process. Start Telegram polling. Load config from a JSON file. Done.

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| WebSocket control plane | Yes | No | SKIP |
| Multi-subsystem boot | Yes | No | SKIP |
| Hot-reload config | Yes | No (restart is fine) | SKIP |
| Zod schema validation | Yes | No (JSON.parse is fine) | SKIP |
| File watchers | Yes | No | SKIP |
| Config file | JSON5 with env vars | Simple JSON | BUILD |

### 2. AGENT LOOP

**OpenClaw**: 4-layer function chain through Pi SDK, tree-structured JSONL, turn validation/repair, multi-provider format translation.

**Eurisco needs**: A `while` loop checking `stop_reason`. Flat message array. One provider (Claude).

```
// The entire agent loop (pseudocode):
async function agentLoop(userMessage, history, tools) {
  history.push({ role: "user", content: userMessage })

  while (true) {
    const response = await claude.messages.create({
      model, system, messages: history, tools, max_tokens
    })
    history.push({ role: "assistant", content: response.content })

    if (response.stop_reason === "end_turn") {
      return response.content.filter(b => b.type === "text").map(b => b.text).join("")
    }

    // Execute tools
    const toolResults = []
    for (const block of response.content.filter(b => b.type === "tool_use")) {
      const result = await executeTool(block.name, block.input)
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result })
    }
    history.push({ role: "user", content: toolResults })
  }
}
```

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| While loop with stop_reason | Yes | Yes | BUILD |
| Anthropic Messages format | Yes | Yes | BUILD |
| Multi-provider translation | Yes | No (Claude only) | SKIP |
| Tree-structured JSONL | Yes | Flat array + JSONL | SIMPLIFY |
| Turn validation/repair | Yes | No (simple append) | SKIP |
| Streaming partial responses | Yes | No (wait for full) | SKIP |
| Max iterations guard | Yes (implicit) | Yes (25 max) | BUILD |

### 3. MEMORY SYSTEM

**OpenClaw**: Markdown files + SQLite with FTS5 + sqlite-vec vectors + hybrid BM25/vector search + MMR reranking + temporal decay + auto-compaction with memory flush.

**Eurisco needs**: Markdown files + SQLite FTS5. No vectors. No MMR. Simple compaction.

**Key insight from research**: OpenClaw itself falls back to BM25-only when vectors are unavailable and works fine. FTS5 handles exact terms (IDs, names, dates) better than vectors anyway.

#### Workspace Layout

```
workspace/
├── SOUL.md          # Personality & instructions (~500-1000 tokens)
├── MEMORY.md        # Curated long-term facts (~1000-2000 tokens)
└── memory/
    ├── 2026-03-06.md   # Yesterday's log
    └── 2026-03-07.md   # Today's log
```

#### Context Loading (every session)
1. SOUL.md content → system prompt
2. MEMORY.md content → injected in system prompt
3. Today's daily log → injected
4. Yesterday's daily log → injected
5. Total startup cost: ~2,000-5,000 tokens (vs OpenClaw's 4,000-10,000)

#### SQLite Schema (minimal)
```sql
CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT, updated_at INTEGER);
CREATE TABLE chunks (id INTEGER PRIMARY KEY, path TEXT, start_line INT, end_line INT, text TEXT, hash TEXT);
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);
```

#### Memory Tools
- `memory_search(query, maxResults=6)` → FTS5 query, return snippets with path + lines
- `memory_save(content)` → append to today's daily log

#### Pre-Compaction Memory Flush (CRITICAL)
This is OpenClaw's most important memory feature. Before truncating old conversation history:
1. Inject a silent system message: "Session nearing limit. Save important context to memory now."
2. Agent writes key facts to daily log
3. Then truncate old turns
4. This converts lossy truncation into a checkpoint operation

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| SOUL.md personality | Yes | Yes | BUILD |
| MEMORY.md long-term | Yes | Yes | BUILD |
| Daily logs (today+yesterday) | Yes | Yes | BUILD |
| SQLite FTS5 search | Yes | Yes | BUILD |
| Vector embeddings | Yes | No | SKIP |
| MMR reranking | Yes | No | SKIP |
| Temporal decay | Yes | No (add later) | SKIP |
| Pre-compaction flush | Yes | Yes | BUILD |
| Chunking (400 tokens, 80 overlap) | Yes | Yes | BUILD |
| USER.md, IDENTITY.md, AGENTS.md | Yes | No (fold into SOUL.md) | SKIP |

### 4. TELEGRAM CHANNEL

**OpenClaw**: grammY with media group buffering, text fragment reassembly, forward burst lanes, streaming draft edits, group chat support, forum topics, inline keyboards.

**Eurisco needs**: grammY with long polling. Handle text. Handle voice (whisper.cpp). Send responses with HTML formatting + chunking.

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| grammY long polling | Yes | Yes | BUILD |
| Text message handling | Yes | Yes | BUILD |
| Voice transcription | Yes (multi-provider) | whisper.cpp local | BUILD |
| Image → vision API | Yes | Phase 2 | DEFER |
| Markdown → HTML conversion | Yes | Yes (simple) | BUILD |
| Message chunking (4096 chars) | Yes | Yes | BUILD |
| Plaintext fallback on HTML error | Yes | Yes | BUILD |
| /start, /clear commands | Yes | Yes | BUILD |
| Text debouncing (1500ms) | Yes | Yes (simple setTimeout) | BUILD |
| Streaming draft edits | Yes | No | SKIP |
| Media group buffering | Yes | No | SKIP |
| Group chat + mentions | Yes | No | SKIP |
| Forum topics | Yes | No | SKIP |
| Inline keyboards | Yes | Phase 2 | DEFER |
| Single-user auth guard | Yes | Yes (check chat_id) | BUILD |

### 5. TOOLS

**OpenClaw**: 20+ built-in tools + ClawHub skill registry + Docker sandbox + approval pipeline.

**Eurisco needs**: 8 core tools. No sandbox. Simple allowlist.

#### Minimum Viable Tool Set

| Tool | What It Does | Implementation |
|------|-------------|----------------|
| `exec` | Run shell commands | `child_process.spawn` + timeout + output capture |
| `read_file` | Read file contents | `fs.readFile` with line numbers |
| `write_file` | Write/create files | `fs.writeFile` atomic |
| `edit_file` | Find-replace in files | String match + replace |
| `web_search` | Search the web | Brave Search API or SearxNG |
| `web_fetch` | Fetch & extract web page | `fetch` + `@mozilla/readability` |
| `memory_search` | Search past memories | SQLite FTS5 query |
| `memory_save` | Save to daily log | Append to `memory/YYYY-MM-DD.md` |

#### Gmail Tools (Phase 1 — use existing Google API auth)
| Tool | What It Does |
|------|-------------|
| `gmail_search` | Search emails |
| `gmail_read` | Read email content |
| `gmail_send` | Send/reply emails |
| `gdoc_create` | Create Google Docs |

#### Phase 2 Tools
| Tool | What It Does |
|------|-------------|
| `calendar_read` | Check Google Calendar |
| `calendar_create` | Create calendar events |
| `system_status` | RPi5 health (temp, disk, RAM) |
| `send_notification` | Proactive Telegram message |

### 6. SCHEDULING & HEARTBEAT

**OpenClaw**: Heartbeat timer with HEARTBEAT.md, cron service with isolated sessions, active hours, webhook triggers.

**Eurisco needs**: node-cron for scheduled tasks. Simple heartbeat with HEARTBEAT_OK suppression.

#### Heartbeat Pattern
```
Every 60 minutes (configurable):
  1. Check if within active hours (e.g., 6 AM - 11 PM)
  2. Read HEARTBEAT.md checklist
  3. Call Claude (Haiku — cheap) with checklist
  4. If response contains "HEARTBEAT_OK" → suppress, do nothing
  5. If response has alert content → send to Telegram
```

#### HEARTBEAT.md Example
```markdown
- Check email for urgent/critical patient alerts
- Check if any scheduled tasks failed
- Review system health (disk, memory, temperature)
- Reply HEARTBEAT_OK if nothing needs attention
```

#### Scheduled Tasks
```javascript
// Morning briefing at 6 AM
cron.schedule('57 5 * * *', () => runTask('morning-briefing'))

// Heartbeat every 60 minutes
cron.schedule('7 * * * *', () => runHeartbeat())
```

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| Heartbeat timer | Yes (30m default) | Yes (60m) | BUILD |
| HEARTBEAT.md checklist | Yes | Yes | BUILD |
| HEARTBEAT_OK suppression | Yes | Yes | BUILD |
| Active hours filtering | Yes | Yes | BUILD |
| Cron scheduled tasks | Yes (complex) | node-cron (simple) | BUILD |
| Isolated cron sessions | Yes | No | SKIP |
| Webhook triggers | Yes | No (add later) | SKIP |
| Light context mode | Yes | Yes (only load HEARTBEAT.md) | BUILD |
| Cheap model for heartbeats | Yes | Yes (Haiku) | BUILD |

### 7. ERROR HANDLING

| Feature | OpenClaw | Eurisco | Status |
|---------|----------|-----|--------|
| LLM API retry (exponential backoff) | Yes (buggy) | Yes (simple: 1s, 5s, 30s, give up) | BUILD |
| Tool error → return to LLM | Yes | Yes | BUILD |
| Telegram reconnect on drop | Yes | Yes (grammY handles this) | FREE |
| Auth profile failover | Yes | No (single API key) | SKIP |
| Context overflow → compaction | Yes | Yes (truncate + flush) | BUILD |
| Graceful degradation message | No (sometimes silent) | Yes ("Sorry, error") | BUILD |

---

## Hosting Decision

| Option | Cost/mo | Latency | Reliability |
|--------|---------|---------|-------------|
| **RPi5 at home** | Rs.30 ($0.30) | Fine for API calls | 95-99% (power/ISP dependent) |
| **GCP e2-micro (free)** | $0 | Excellent to Claude API | 99.95% |
| **Hetzner CAX11** | $4.85 | Good | 99.9% |
| **DigitalOcean BLR** | $4 | Best from India | 99.99% |

**Recommendation**: RPi5 primary + GCP free tier as automatic failover = ~$0/month with cloud reliability.

---

## Technology Choices (Final)

| Component | Choice | Why |
|-----------|--------|-----|
| Language | **TypeScript** | Type safety, matches OpenClaw ecosystem |
| Runtime | **Node.js 22** | Already on Pi, lightweight |
| Telegram | **grammY** | Modern, 30-50MB RAM, long polling |
| LLM | **Claude API** (Haiku + Sonnet) | Best tool use, prompt caching |
| Database | **better-sqlite3** + FTS5 | Zero config, single file, crash resilient |
| Memory | **Markdown files** | Proven OpenClaw pattern |
| Scheduler | **node-cron** | In-process, simple |
| Web search | **Brave Search API** or **SearxNG** | Brave: $0 for 2K queries/mo. SearxNG: free, self-hosted |
| Web fetch | **@mozilla/readability** + **jsdom** | Lightweight HTML→markdown |
| Voice | **whisper.cpp** (base model) | Local, free, ~140MB RAM on demand |
| Process mgr | **systemd** | Zero overhead, auto-restart |
| Config | **JSON** (not JSON5) | Simpler, native parsing |

---

## Resource Budget (RPi5 4GB)

| Component | RAM |
|-----------|-----|
| Node.js + grammY + agent loop | 80-120 MB |
| SQLite (FTS5) | 5-10 MB |
| whisper.cpp base (on demand) | 140 MB (released after use) |
| Weather Station (existing) | 72 MB |
| Tailscale (existing) | 42 MB |
| OS + system services | 300 MB |
| **Total peak** | **~640-680 MB** |
| **Free RAM** | **~3.3 GB** |

---

## Estimated API Costs

| Usage | Model | Monthly Cost |
|-------|-------|-------------|
| 50 messages/day (simple) | Haiku 4.5 | ~$2-3 |
| 10 messages/day (complex) | Sonnet 4.5 | ~$3-5 |
| Heartbeat (24x/day) | Haiku 4.5 | ~$1-2 |
| Morning briefing (1x/day) | Sonnet 4.5 | ~$1-2 |
| Prompt caching savings | -30-50% | -$2-4 |
| **Total estimated** | | **$5-10/month** |

---

## Existing Minimal Projects Worth Studying

| Project | Language | Size | RAM | Notes |
|---------|----------|------|-----|-------|
| **claw0** | Python | ~10 files | Minimal | OpenClaw tutorial, proves core is ~200 lines |
| **NanoBot** | Python | ~4,000 lines | <100MB | Telegram + memory + 11 LLM providers. Best match for Eurisco |
| **PicoClaw** | Go | <10MB binary | <10MB | Runs on $10 boards. Most extreme minimal option |
| **ZeroClaw** | Rust | 3.4MB binary | 7.8MB | <10ms startup. Bare-metal performance |

---

## Build Order (Phase 1 MVP)

1. **Project scaffold** — package.json, tsconfig, directory structure
2. **Config loader** — read JSON config (API keys, bot token, user ID)
3. **Agent loop** — while loop with Claude API tool use
4. **Tool executor** — dispatch table: name → function
5. **Core tools** — exec, read, write, edit, memory_search, memory_save
6. **Telegram bot** — grammY, long polling, single-user auth, text handler
7. **Memory system** — SOUL.md + MEMORY.md + daily logs + SQLite FTS5
8. **System prompt** — template with SOUL.md + memory + tools
9. **Gmail tools** — search, read, send (use existing Google API auth)
10. **Heartbeat** — node-cron, HEARTBEAT.md, HEARTBEAT_OK suppression
11. **Morning briefing** — cron at 6 AM, email summary → Telegram
12. **Systemd service** — auto-start, auto-restart on crash
13. **Voice handling** — whisper.cpp for voice message transcription

---

## Key Architectural Insights from OpenClaw

1. **The agent loop is trivial** — it's a while loop. The magic is in the tools and memory, not the loop.
2. **File-first memory beats databases** — SOUL.md + daily logs + FTS5 search is simple and effective. Skip vectors.
3. **Pre-compaction flush is the killer feature** — save important context before truncating history. This one pattern prevents most "the bot forgot" problems.
4. **Progressive skill disclosure saves tokens** — only load full skill instructions when needed, not upfront.
5. **HEARTBEAT_OK suppression** — simple string check that prevents notification spam. Trivial to implement, huge UX improvement.
6. **The LLM is the router** — no algorithmic skill matching needed. The LLM reads descriptions and picks the right skill. Trust the model.
7. **Prompt caching is essential for cost** — keep system prompt stable across requests to maximize cache hits.
