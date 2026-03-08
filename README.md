# Eurisco

A personal AI agent that lives in Telegram. Powered by Google Gemini, it manages your email, calendar, contacts, and memory — and learns about you over time.

Runs on a Raspberry Pi 5 (4GB RAM is enough). Self-hosted, privacy-first, extensible.

## Why Eurisco

Most AI assistant projects (including OpenClaw, which inspired parts of this architecture) focus on making the LLM smarter at tasks — better prompts, better tool use, better workflows. Eurisco does that too, but its real differentiator is **people memory**.

**The problem**: Every AI assistant treats each conversation as isolated. They don't know who you emailed last week, who you're meeting tomorrow, or that the person you're about to call hasn't replied in 45 days. Your relationships — the most important part of your professional and personal life — are invisible to them.

**What Eurisco does differently**:
- **Builds a living database of every person you interact with** — automatically, from your email. Names, roles, organisations, topics discussed, interaction timeline, and connections between people.
- **Learns passively** — after every conversation, it extracts insights about your travel, interests, work, health, and relationships. It remembers that you prefer window seats, that your colleague Priya is working on the STEMI project, and that you haven't spoken to your college friend in 3 months.
- **Surfaces context before you ask** — before a meeting, it can pull up everything it knows about the attendees. When you search for a flight, it already knows your airline preferences.
- **Tracks relationship health** — contacts are classified as hot (< 14 days), active (< 30 days), or cold (> 90 days). The morning briefing flags follow-ups that are going stale.

### How it compares to OpenClaw

| | OpenClaw | Eurisco |
|---|---------|---------|
| **Focus** | General-purpose skill framework | Personal assistant with relationship intelligence |
| **Skills** | YAML frontmatter, workspace/managed/bundled tiers | TypeScript modules, single registry, flat structure |
| **Memory** | Three-tier (workspace/project/conversation) | Two-tier (daily markdown logs + SQLite FTS5 search) + people DB |
| **People** | None | Full CRM — auto-built from email, web-verified, with interaction tracking |
| **Inference** | Cloud-only | Optimised for Raspberry Pi (API-bound, not CPU-bound) |
| **Channel** | IDE/CLI | Telegram (mobile + desktop, voice messages) |
| **Composition** | Agent-level (LLM decides) | Same — skills never call each other, LLM composes |

We borrowed OpenClaw's best idea: skills as prompt injection, not code coupling. But we went further on the personal intelligence side — the people database, passive learning, and relationship tracking are what make Eurisco feel like it actually knows you.

### Optimised for Raspberry Pi

Eurisco is designed to run 24/7 on a Raspberry Pi 5 with just 4GB RAM. This works because:

- **The bottleneck is the API, not the CPU.** Gemini API calls account for 80-98% of response time. A Pi performs identically to a MacBook — the network round-trip dominates everything.
- **SQLite, not Postgres.** The people database and memory search use better-sqlite3 with FTS5. No database server, no memory overhead, no config.
- **No heavy dependencies.** No Python, no Docker, no vector databases. Just Node.js, TypeScript, and a few npm packages.
- **Smart model routing.** Simple queries use Gemini Flash (fast, cheap). Complex queries use Gemini Pro. You control the split.
- **Context pruning.** Old tool results are automatically trimmed. History is capped at 80 turns with pre-compaction memory flush so nothing important is lost.

Total idle memory: ~60MB. Peak during a complex query: ~120MB.

## What It Does

- **Email** — Search, read, and send Gmail across multiple accounts
- **Calendar** — List and create Google Calendar events
- **Flights** — Search flights via Amadeus API
- **Memory** — Remembers your preferences, plans, and conversations
- **People** — Builds a CRM from your email — tracks contacts, relationships, follow-ups, and connections between people
- **Voice** — Transcribes voice messages and responds
- **Morning Briefing** — Daily Telegram digest of unread emails, today's calendar, and stale follow-ups
- **Deep Search** — Parallel search across email, memory, people, and web in a single tool call

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/drcharit/eurisco.git
cd eurisco
npm install
```

### 2. Get API keys

| Service | Where | Required |
|---------|-------|----------|
| Gemini API | [aistudio.google.com](https://aistudio.google.com/apikey) | Yes |
| Telegram Bot | [@BotFather](https://t.me/BotFather) on Telegram | Yes |
| Google OAuth | [Cloud Console](https://console.cloud.google.com/apis/credentials) | For email/calendar |
| Amadeus | [developers.amadeus.com](https://developers.amadeus.com) | For flights |

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your API keys

cp workspace/SOUL.example.md workspace/SOUL.md
# Customise the persona to your liking
```

For Google OAuth refresh tokens, you'll need to run the OAuth flow once. See [Google Auth Setup](#google-auth-setup) below.

### 4. Build and run

```bash
npm run build
npm start
```

### 5. Deploy (optional — Raspberry Pi)

```bash
# From your dev machine
rsync -avz --exclude node_modules --exclude .git ./ user@your-pi:/home/user/eurisco/

# On the Pi
cd /home/user/eurisco
npm install
npm run build
npx pm2 start dist/index.js --name eurisco
npx pm2 save
```

## Configuration

### config/kit.json

```json
{
  "activeHours": { "start": 6, "end": 23 },
  "heartbeatIntervalMinutes": 60,
  "morningBriefingCron": "57 5 * * *",
  "maxAgentIterations": 25,
  "maxRetries": 3,
  "models": {
    "fast": "gemini-2.5-flash",
    "smart": "gemini-2.5-pro"
  },
  "followUpThresholds": {
    "hotDays": 14,
    "activeDays": 30,
    "coldDays": 90
  }
}
```

- **activeHours** — heartbeat only runs during these hours
- **morningBriefingCron** — when to send the daily digest (cron syntax)
- **models.fast** — used for simple queries, transcription, reflect
- **models.smart** — used for complex queries (analyze, compare, draft, etc.)

### workspace/SOUL.md

This is your bot's personality and instructions. It's loaded into the system prompt on every request. Edit it to change:
- How the bot speaks and formats responses
- What it learns and remembers about you
- Search strategies and tool usage patterns

## Architecture

```
src/
├── index.ts              # Entry point
├── config.ts             # Config loader (.env + kit.json)
├── db.ts                 # SQLite database
├── agent/
│   ├── loop.ts           # Agent loop (chat + tool execution + streaming)
│   ├── history.ts        # Conversation history (80 turns, JSONL persistence)
│   └── prompt.ts         # System prompt builder
├── skills/
│   ├── types.ts          # Skill interface
│   ├── registry.ts       # Skill registry
│   ├── travel.ts         # Flight search, airport lookup
│   ├── comms.ts          # Gmail, Google Calendar
│   ├── knowledge.ts      # Deep search, memory, people database
│   └── system.ts         # Shell exec, file read/write
├── channels/
│   └── telegram.ts       # Telegram bot (grammY)
├── memory/
│   ├── markdown.ts       # Markdown-based daily memory logs
│   └── search.ts         # SQLite FTS5 memory search
├── people/
│   └── tools.ts          # People database (upsert, log, search)
└── services/
    ├── gmail.ts           # Gmail API
    ├── calendar.ts        # Google Calendar API
    ├── google-auth.ts     # OAuth2 multi-account auth
    ├── flights.ts         # Amadeus flight search
    ├── web.ts             # Web search + fetch
    └── heartbeat.ts       # Cron: heartbeat + morning briefing
```

### Skill System

Skills are self-contained modules. Each provides tool declarations (for Gemini) and handlers (for execution). To add a new skill:

```typescript
// src/skills/my-skill.ts
import type { Skill } from "./types.js";

export const mySkill: Skill = {
  name: "my-skill",
  description: "What it does — shown to the model in system prompt",
  tools: [
    {
      name: "my_tool",
      description: "What this tool does",
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "Search query" },
        },
        required: ["query"],
      },
    },
  ],
  createHandlers(ctx) {
    return {
      my_tool: async (args) => {
        const query = args["query"] as string;
        // Your logic here
        return `Result for: ${query}`;
      },
    };
  },
};
```

Then register in `src/index.ts`:
```typescript
import { mySkill } from "./skills/my-skill.js";
registry.register(mySkill);
```

The skill's tools automatically appear in the Gemini function declarations, and its description is injected into the system prompt.

## Google Auth Setup

1. Create a project at [Google Cloud Console](https://console.cloud.google.com)
2. Enable Gmail API and Google Calendar API
3. Create OAuth 2.0 credentials (Desktop app type)
4. Set the Client ID and Secret in `.env`
5. To get refresh tokens for each account, run a one-time OAuth flow:

```bash
# Install the helper
npx google-auth-library

# Or use this Node.js script:
node -e "
const { google } = require('googleapis');
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3000/callback'
);
const url = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
  ],
});
console.log('Visit:', url);
"
```

6. After authorizing, you'll get a refresh token. Add it to `.env`.

## License

MIT
