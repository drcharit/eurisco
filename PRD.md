# Eurisco — Product Requirements Document

## Overview

**Eurisco** is a personal AI assistant that runs as a Telegram bot, powered by Google's Gemini API. It acts as an intelligent agent — not a chatbot — that can search your email, manage your calendar, track your contacts, remember your preferences, and proactively help you stay on top of your life.

**Kit** is the Telegram bot interface to Eurisco.

## Problem Statement

Existing AI assistants are either:
- **Stateless chatbots** — no memory, no access to your data, no proactive help
- **Enterprise platforms** — complex, expensive, designed for teams not individuals
- **Single-purpose bots** — can do one thing (email OR calendar OR search) but don't connect the dots

There's no good **personal AI agent** that:
1. Has access to your email, calendar, and contacts across multiple accounts
2. Remembers everything about you and learns over time
3. Proactively surfaces information and suggests next steps
4. Runs on your own hardware with your own API keys (privacy-first)
5. Is extensible with new skills

## Target User

An individual who:
- Uses Gmail and Google Calendar
- Wants an AI assistant accessible via Telegram (mobile + desktop)
- Values privacy — wants to self-host rather than trust a SaaS
- Has moderate technical ability (can set up a Raspberry Pi, get API keys)

## Core Capabilities

### 1. Intelligent Conversation
- Natural language interface via Telegram (text + voice)
- Voice messages transcribed and processed as text
- Streaming responses with real-time "Working..." updates
- Context-aware — remembers conversation history (80 turns)
- Model routing: fast model (Flash) for simple queries, smart model (Pro) for complex ones

### 2. Email Integration (Gmail)
- Multi-account support (up to 5 Google accounts)
- Search, read, and send emails
- Deep search: parallel search across all accounts with query expansion
- Auto-reads top emails from search results for context

### 3. Calendar Integration (Google Calendar)
- Multi-account support
- List upcoming events across all calendars
- Create new events with attendees

### 4. Flight Search
- Amadeus API integration for real-time flight search
- Airport code lookup
- Structured output with recommendations (best value, cheapest, premium)

### 5. Memory System
- **Daily markdown logs** — everything saved to dated files in `workspace/memory/`
- **SQLite FTS5 search** — full-text search across all memories
- **Passive learning** — after each conversation, extracts insights about the user (travel, interests, work, health, people, preferences, plans)
- **Pre-compaction flush** — saves important context before history is trimmed

### 6. People Database
- Tracks everyone the user interacts with
- Stores: name, email, organization, role, relationship, notes
- Interaction logging with timestamps
- Follow-up tracking (hot/active/cold contacts)
- Searchable by name, email, or organization

### 7. Proactive Features
- **Morning briefing** — daily Telegram digest of unread emails, today's calendar, due follow-ups
- **Heartbeat** — periodic check against a customisable checklist (HEARTBEAT.md)
- **Reflect** — passive insight extraction after every conversation

### 8. System Tools
- Execute shell commands on the host machine
- Read and write files in the workspace

## Architecture

### Skill System
Eurisco uses a modular **skill system**. Each skill is a self-contained module that provides:
- `name` — identifier
- `description` — what the skill does (injected into system prompt)
- `tools[]` — Gemini function declarations
- `createHandlers(ctx)` — tool implementation functions

**Built-in skills:**
| Skill | Tools | Description |
|-------|-------|-------------|
| `travel` | `flight_search`, `airport_search` | Flight search and airport lookups |
| `comms` | `gmail_search`, `gmail_read`, `gmail_send`, `calendar_list`, `calendar_create` | Email and calendar |
| `knowledge` | `deep_search`, `memory_search`, `memory_save`, `people_search`, `people_upsert`, `people_log` | Search, memory, contacts |
| `system` | `exec`, `read_file`, `write_file` | System operations |

### Adding a New Skill

Create a `.ts` file in `src/skills/`:

```typescript
import type { Skill } from "./types.js";

export const mySkill: Skill = {
  name: "my-skill",
  description: "What it does",
  tools: [
    // Gemini FunctionDeclaration objects
  ],
  createHandlers(ctx) {
    return {
      my_tool: async (args) => {
        // Implementation
        return "result string";
      },
    };
  },
};
```

Register it in `src/index.ts`:
```typescript
import { mySkill } from "./skills/my-skill.js";
registry.register(mySkill);
```

### Agentic Workflow

The system prompt instructs the model to follow a 5-phase workflow:
1. **UNDERSTAND** — classify the query type and required depth
2. **PLAN** — decide which tools to use and in what order
3. **EXECUTE** — run tools, chain results, recover from failures
4. **SYNTHESIZE** — interpret results, compare, rank, recommend
5. **SUGGEST** — end with 2-3 concrete next actions

### Persona (SOUL.md)

The bot's personality and behaviour are defined in `workspace/SOUL.md`. This file is loaded into the system prompt on every request. Customise it to change:
- Personality and tone
- Response depth and format
- Search strategies
- What the bot learns and remembers

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript |
| LLM | Google Gemini API (`@google/generative-ai`) |
| Messaging | Telegram via grammY |
| Database | better-sqlite3 (FTS5 for memory search) |
| Email/Calendar | Google APIs (googleapis) |
| Flights | Amadeus API |
| Scheduling | node-cron |
| Hosting | Raspberry Pi 5 (or any Linux/macOS machine) |

## Infrastructure Requirements

- **Raspberry Pi 5** (4GB+ RAM) or any always-on machine
- **Network**: outbound HTTPS (no inbound ports needed)
- **API Keys**:
  - Google Gemini API key
  - Telegram Bot Token (from @BotFather)
  - Google OAuth credentials (for Gmail/Calendar)
  - Amadeus API credentials (optional, for flights)

## Performance

- Gemini API calls are 80-98% of total response time
- Tool execution (Gmail, web, flights) is <5%
- Setup and prompt building is negligible
- RPi5 performs identically to Mac (bottleneck is API latency, not CPU)
- History pruning keeps context lean (prune old tool results >10 turns)

## Privacy & Security

- **Self-hosted** — runs on your hardware, no data leaves to third parties (except API calls)
- **No telemetry** — no analytics, no tracking
- **Credentials in .env** — never hardcoded, never committed
- **Owner-only** — Telegram bot ignores messages from anyone except the configured owner ID
- **Local database** — SQLite on disk, no cloud database

## Future Roadmap

- [ ] Web search API integration (Brave Search or similar)
- [ ] Multi-channel support (WhatsApp, Discord, web UI)
- [ ] Scheduled tasks and reminders
- [ ] Document analysis (PDF, spreadsheets)
- [ ] Smart home integration
- [ ] Community skill marketplace
