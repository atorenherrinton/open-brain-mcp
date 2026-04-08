# Open Brain — Setup

The infrastructure layer for your thinking. Capture thoughts from anywhere, query them by meaning, and dispatch tasks to a local AI agent on a daily schedule.

Two pieces:

1. **Open Brain MCP** — a Supabase Edge Function that exposes both an MCP-over-HTTP endpoint (for Claude / Gemini / other agents) and a small REST API (for the Apple Shortcut). All data lives in Supabase Postgres with pgvector for semantic search.
2. **Daily task dispatcher** — a launchd-scheduled shell script that fires `claude --print` once a day, walks your task queue via the Open Brain MCP, and commits / pushes work for tasks tied to a code working directory.

There is no local server. Nothing runs in Docker. The only host process is whatever your scheduler fires.

---

## Prerequisites

- A Mac (for the Apple Shortcut and the launchd-scheduled dispatcher; everything else is portable)
- A Supabase project ([signup](https://supabase.com/))
- An OpenRouter API key for embeddings + classification
- The Supabase CLI: `brew install supabase/tap/supabase`
- Claude Code installed on the host: `claude --version` should print

---

## Part 1 — Deploy the MCP backend (Supabase)

### 1. Configure env

```bash
cp .env.example .env
```

Fill in:

- `SUPABASE_DB_URL` — pooled connection string (Project Settings → Database → Connection Pooling)
- `SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `SUPABASE_SECRET_KEY` — service role key (Project Settings → API)
- `OPENROUTER_API_KEY` — for `text-embedding-3-small` and `gpt-4o-mini`
- `MCP_ACCESS_KEY` — any random string; clients send this as `x-brain-key`

### 2. Link the repo to your project

```bash
supabase init
supabase link --project-ref <your-project-ref>
```

### 3. Push the schema

```bash
npm run supabase:db:push
```

This applies everything under `supabase/migrations/` — `thoughts`, `personal_info`, `tasks`, `task_notes`, `projects`, plus the pgvector extension and search functions.

### 4. Deploy the Edge Function

```bash
npm run supabase:functions:deploy
```

The function exposes:

- `POST /functions/v1/open-brain/mcp` — MCP-over-HTTP, for AI agents
- `POST /functions/v1/open-brain/capture` — REST capture, for the Apple Shortcut
- `POST /functions/v1/open-brain/search` — REST semantic search
- `GET  /functions/v1/open-brain/thoughts` — REST list
- `GET  /functions/v1/open-brain/stats` — REST stats
- `GET  /functions/v1/open-brain/health` — health check

All non-`/health` routes require the `x-brain-key` header.

### 5. Smoke test

```bash
curl https://<project-ref>.supabase.co/functions/v1/open-brain/health
# {"status":"ok","thoughts":0}

curl -X POST https://<project-ref>.supabase.co/functions/v1/open-brain/capture \
  -H "x-brain-key: <your-MCP_ACCESS_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"content":"Hello brain","source":"setup-test"}'
```

---

## Part 2 — Apple Shortcut capture

Create a shortcut named **Capture Thought**:

1. Open **Shortcuts** on your Mac (or iPhone)
2. Add **Ask for Input** → Prompt: "Capture", Type: Text
3. Add **Get Contents of URL**
   - URL: `https://<project-ref>.supabase.co/functions/v1/open-brain/capture`
   - Method: POST
   - Headers:
     - `x-brain-key`: `<your-MCP_ACCESS_KEY>`
     - `Content-Type`: `application/json`
   - Request Body: JSON
     - `content`: Provided Input
     - `source`: `shortcut`
4. Add **Show Result** → Get Dictionary Value: `confirmation`

Assign a keyboard shortcut via System Settings → Keyboard → Keyboard Shortcuts → Services. Now you can capture from anywhere with one keystroke. Works identically on iPhone — same URL, no local network gymnastics.

---

## Part 3 — Connect AI agents to the MCP

### Claude (claude.ai or Claude Code)

Add the MCP server in Claude's MCP settings:

- URL: `https://<project-ref>.supabase.co/functions/v1/open-brain/mcp`
- Header: `x-brain-key: <your-MCP_ACCESS_KEY>`

Tools become available as `capture_thought`, `search_thoughts`, `list_tasks`, `create_task`, etc.

### Gemini CLI

```bash
gemini mcp add --transport http open-brain-mcp \
  https://<project-ref>.supabase.co/functions/v1/open-brain/mcp \
  --scope user \
  --trust \
  -H "x-brain-key: <your-MCP_ACCESS_KEY>"
```

Or copy [gemini-settings.example.json](./gemini-settings.example.json) into `~/.gemini/settings.json`.

### Other agents

Any MCP-compatible client that supports HTTP transport works. See [SUPABASE.md](./SUPABASE.md).

---

## Part 4 — Daily task dispatcher (optional)

If you want a local Claude agent to wake up once a day and grind through your task queue, set up the launchd dispatcher.

### How it works

`scripts/daily-dispatch.sh` invokes `claude --print` headlessly with a prompt that walks `list_tasks` (todo + in_progress) via the Open Brain MCP, cd's into each task's `working_dir`, does the work, commits, pushes, verifies the push, and updates the task status. Skips tasks without a valid `working_dir`.

### 1. Install the script

The script must live somewhere outside `~/Documents`, `~/Desktop`, or `~/Downloads` — macOS TCC blocks launchd from executing files in those locations.

```bash
mkdir -p ~/.local/bin
cp scripts/daily-dispatch.sh ~/.local/bin/openbrain-daily-dispatch.sh
chmod +x ~/.local/bin/openbrain-daily-dispatch.sh
```

### 2. Create the LaunchAgent

Save this to `~/Library/LaunchAgents/com.openbrain.dailydispatch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openbrain.dailydispatch</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/YOUR_USERNAME/.local/bin/openbrain-daily-dispatch.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>1</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/Library/Logs/open-brain-dispatch.launchd.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/Library/Logs/open-brain-dispatch.launchd.log</string>
</dict>
</plist>
```

01:00 local time = 08:00 UTC during PDT (most of the year), 09:00 UTC during PST. launchd has no UTC mode.

### 3. Strip the provenance xattr and bootstrap

macOS Sequoia tags files written by Claude Code with `com.apple.provenance`, and launchd refuses to load plists carrying it. One-time fix:

```bash
sudo xattr -d com.apple.provenance ~/Library/LaunchAgents/com.openbrain.dailydispatch.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openbrain.dailydispatch.plist
```

### 4. Test it without waiting for 01:00

```bash
launchctl kickstart gui/$(id -u)/com.openbrain.dailydispatch
tail -f ~/Library/Logs/open-brain-dispatch.log
```

You should see "Invoking claude..." then Claude's run summary at the end.

### 5. Edit the script in the repo, redeploy

The repo copy at `scripts/daily-dispatch.sh` is the source of truth. After editing:

```bash
cp scripts/daily-dispatch.sh ~/.local/bin/openbrain-daily-dispatch.sh
```

### Unloading

```bash
launchctl bootout gui/$(id -u)/com.openbrain.dailydispatch
```

---

## Repo layout

```
.
├── scripts/
│   └── daily-dispatch.sh          # the launchd-scheduled task dispatcher
├── supabase/
│   ├── config.toml
│   ├── functions/open-brain/      # the Edge Function (MCP + REST)
│   └── migrations/                # schema for thoughts, tasks, projects, etc.
├── .env.example
├── package.json                   # only supabase CLI script wrappers
├── SETUP.md                       # this file
├── SUPABASE.md                    # deeper Supabase setup notes
└── Personal Context.instructions.md   # AI agent behavior guide
```

That's it. No Node server, no Docker, no local Postgres, no test suite. The MCP backend is one Edge Function deployment; the dispatcher is one shell script.
