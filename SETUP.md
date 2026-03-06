# Build Your Open Brain — Local Edition

**Complete Setup Guide**

The infrastructure layer for your thinking. One local database, one AI gateway, one Apple Shortcut. Any AI you use can plug in. No cloud services, no Slack, no Supabase — everything runs on your Mac.

---

## What You're Building

A **local PostgreSQL database** with vector search that stores your thoughts with embeddings and metadata. An **Apple Shortcut** that lets you capture a thought from anywhere on your Mac/iPhone with a text input — it gets embedded, classified, and stored automatically. Then an **MCP server** running locally that lets any AI assistant search your brain by meaning — and write to it directly.

## What You Need

- About 30 minutes and basic comfort with a terminal
- A Mac (for the Apple Shortcut capture; the rest works on any OS)
- An OpenRouter account (for embeddings and metadata extraction)

## Cost Breakdown

| Service | Cost |
|---|---|
| PostgreSQL (local) | $0 |
| Node.js server (local) | $0 |
| Embeddings (text-embedding-3-small via OpenRouter) | ~$0.02 / million tokens |
| Metadata extraction (gpt-4o-mini via OpenRouter) | ~$0.15 / million input tokens |

For 20 thoughts/day: roughly **$0.10–0.30/month** in API costs.

---

## Credential Tracker

Copy into a text editor and fill in as you go:

```
OPEN BRAIN LOCAL — CREDENTIAL TRACKER
--------------------------------------

OPENROUTER
  Account email:      ____________
  API key:            ____________  <- Step 2

POSTGRESQL (LOCAL)
  Host:               localhost
  Port:               5432
  Database name:      open_brain
  User:               ____________  (your Mac username or 'postgres')
  Password:           ____________  (if you set one)

GENERATED DURING SETUP
  MCP Access Key:     ____________  <- Step 5
  Server Port:        3333

--------------------------------------
```

---

## Part 1 — Database Setup

### Step 1: Install PostgreSQL with pgvector

You need PostgreSQL with the `pgvector` extension for vector similarity search.

**Install via Homebrew:**

```bash
brew install postgresql@16
brew services start postgresql@16
```

**Install pgvector:**

```bash
brew install pgvector
```

> 💡 If `brew install pgvector` doesn't work, install from source:
> ```bash
> git clone https://github.com/pgvector/pgvector.git
> cd pgvector
> make
> make install
> ```

**Create the database:**

```bash
createdb open_brain
```

**Verify it works:**

```bash
psql open_brain -c "SELECT 1;"
```

### Step 2: Get an OpenRouter API Key

OpenRouter is a universal AI API gateway — one account gives you access to every major model.

1. Go to [openrouter.ai](https://openrouter.ai) and sign up
2. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
3. Click **Create Key**, name it `open-brain`
4. Copy the key into your credential tracker
5. Add $5 in credits under Credits (lasts months)

### Step 3: Set Up the Database Schema

Open a psql session and run the following SQL commands:

```bash
psql open_brain
```

**Enable the vector extension:**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Create the thoughts table:**

```sql
CREATE TABLE thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding vector(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast vector similarity search
CREATE INDEX ON thoughts
  USING hnsw (embedding vector_cosine_ops);

-- Index for filtering by metadata fields
CREATE INDEX ON thoughts USING gin (metadata);

-- Index for date range queries
CREATE INDEX ON thoughts (created_at DESC);

-- Auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at
  BEFORE UPDATE ON thoughts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

**Create the semantic search function:**

```sql
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding vector(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  metadata JSONB,
  similarity FLOAT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.content,
    t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**Quick verification:**

```bash
psql open_brain -c "\dt"
# Should show the 'thoughts' table

psql open_brain -c "\df match_thoughts"
# Should show the function
```

---

## Part 2 — Local Server

### Step 4: Create the Project

```bash
mkdir -p ~/open-brain-mcp && cd ~/open-brain-mcp
npm init -y
npm install express pg pgvector
```

**Create a `.env` file:**

```bash
cat > .env << 'EOF'
OPENROUTER_API_KEY=your-openrouter-key-here
DATABASE_URL=postgresql://localhost:5432/open_brain
MCP_ACCESS_KEY=generate-this-in-step-5
SERVER_PORT=3333
EOF
```

### Step 5: Generate an Access Key

```bash
openssl rand -hex 32
```

Copy the output and paste it into:
- Your credential tracker under **MCP Access Key**
- The `.env` file replacing `generate-this-in-step-5`

### Step 6: Create the Server

Create the file `server.js`:

```javascript
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const pgvector = require("pgvector");

// ─── Config ───────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;
const PORT = parseInt(process.env.SERVER_PORT || "3333", 10);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const pool = new Pool({ connectionString: DATABASE_URL });

// Register pgvector type on each new client
pool.on("connect", async (client) => {
  await pgvector.registerTypes(client);
});

const app = express();
app.use(express.json());

// ─── AI Helpers ───────────────────────────────────────────
async function getEmbedding(text) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Embedding failed: ${res.status} ${msg}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractMetadata(text) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// ─── Auth Middleware ───────────────────────────────────────
function requireKey(req, res, next) {
  const key =
    req.headers["x-brain-key"] || req.query.key;
  if (!key || key !== MCP_ACCESS_KEY) {
    return res.status(401).json({ error: "Invalid or missing access key" });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────

// Health check (no auth)
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", thoughts: (await pool.query("SELECT count(*) FROM thoughts")).rows[0].count });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ── Capture a thought ─────────────────────────────────────
app.post("/capture", requireKey, async (req, res) => {
  try {
    const { content, source } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }

    const [embedding, metadata] = await Promise.all([
      getEmbedding(content),
      extractMetadata(content),
    ]);

    const result = await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [content, pgvector.toSql(embedding), { ...metadata, source: source || "api" }]
    );

    const meta = metadata;
    let confirmation = `Captured as ${meta.type || "thought"}`;
    if (meta.topics?.length) confirmation += ` — ${meta.topics.join(", ")}`;
    if (meta.people?.length) confirmation += ` | People: ${meta.people.join(", ")}`;
    if (meta.action_items?.length) confirmation += ` | Actions: ${meta.action_items.join("; ")}`;

    res.json({
      success: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      confirmation,
      metadata,
    });
  } catch (err) {
    console.error("Capture error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Semantic search ───────────────────────────────────────
app.post("/search", requireKey, async (req, res) => {
  try {
    const { query, limit = 10, threshold = 0.5, filter = {} } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const queryEmbedding = await getEmbedding(query);

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
      [pgvector.toSql(queryEmbedding), threshold, limit, JSON.stringify(filter)]
    );

    res.json({ count: rows.length, results: rows });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── List recent thoughts ──────────────────────────────────
app.get("/thoughts", requireKey, async (req, res) => {
  try {
    const { limit = 10, type, topic, person, days } = req.query;

    let sql = `SELECT id, content, metadata, created_at FROM thoughts`;
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (type) {
      conditions.push(`metadata->>'type' = $${paramIdx++}`);
      params.push(type);
    }
    if (topic) {
      conditions.push(`metadata->'topics' ? $${paramIdx++}`);
      params.push(topic);
    }
    if (person) {
      conditions.push(`metadata->'people' ? $${paramIdx++}`);
      params.push(person);
    }
    if (days) {
      conditions.push(`created_at >= now() - interval '${parseInt(days)} days'`);
    }

    if (conditions.length) sql += ` WHERE ` + conditions.join(" AND ");
    sql += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(parseInt(limit));

    const { rows } = await pool.query(sql, params);
    res.json({ count: rows.length, thoughts: rows });
  } catch (err) {
    console.error("List error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ─────────────────────────────────────────────────
app.get("/stats", requireKey, async (req, res) => {
  try {
    const { rows: countRows } = await pool.query("SELECT count(*) FROM thoughts");
    const total = parseInt(countRows[0].count);

    const { rows: allRows } = await pool.query(
      "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
    );

    const types = {};
    const topics = {};
    const people = {};

    for (const r of allRows) {
      const m = r.metadata || {};
      if (m.type) types[m.type] = (types[m.type] || 0) + 1;
      if (Array.isArray(m.topics))
        for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
      if (Array.isArray(m.people))
        for (const p of m.people) people[p] = (people[p] || 0) + 1;
    }

    const sortObj = (o) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k, v]) => ({ name: k, count: v }));

    res.json({
      total,
      date_range: allRows.length
        ? {
            earliest: allRows[allRows.length - 1].created_at,
            latest: allRows[0].created_at,
          }
        : null,
      types: sortObj(types),
      top_topics: sortObj(topics),
      people_mentioned: sortObj(people),
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🧠 Open Brain server running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
```

Install dotenv:

```bash
npm install dotenv
```

**Start the server:**

```bash
node server.js
```

> 💡 You should see:
> ```
> 🧠 Open Brain server running at http://localhost:3333
>    Health check: http://localhost:3333/health
> ```

**Test the health check:**

```bash
curl http://localhost:3333/health
```

---

## Part 3 — Apple Shortcut Capture

### Step 7: Create the Apple Shortcut

This replaces Slack entirely. You'll have a shortcut that:
1. Prompts you for text
2. Sends it to your local server
3. Shows you the confirmation

**Create the shortcut manually in the Shortcuts app:**

1. Open **Shortcuts** on your Mac (or iPhone)
2. Click **+** to create a new shortcut
3. Name it **"Capture Thought"**

**Add these actions in order:**

**Action 1 — Ask for Input:**
- Search actions for **"Ask for Input"**
- Set the prompt to: `What's on your mind?`
- Input type: **Text**

**Action 2 — Get Contents of URL (this is the HTTP request):**
- Search actions for **"Get Contents of URL"**
- URL: `http://localhost:3333/capture`
- Method: **POST**
- Headers:
  - `Content-Type`: `application/json`
  - `x-brain-key`: `your-access-key-from-step-5`
- Request Body (JSON):
  - `content`: select **"Provided Input"** from the Ask for Input step
  - `source`: `shortcut`

**Action 3 — Get Dictionary Value:**
- Search actions for **"Get Dictionary Value"**
- Get value for key: `confirmation`
- From: **"Contents of URL"** (the output of the previous step)

**Action 4 — Show Notification:**
- Search actions for **"Show Notification"**
- Body: select the **"Dictionary Value"** from the previous step
- Title: `🧠 Open Brain`

**That's it.** Four actions.

> 💡 **Keyboard shortcut tip:** Go to System Settings → Keyboard → Keyboard Shortcuts → Services → find your "Capture Thought" shortcut and assign a hotkey (e.g., `⌃⌥⌘T`). Now you can capture a thought from anywhere with one keystroke.

> 💡 **iPhone note:** The shortcut works identically on iPhone. If your Mac server is running on the same network, replace `localhost` with your Mac's local IP (find it in System Settings → Network, e.g., `192.168.1.42`). Or set it up to work only when on your home network.

> ⚠️ **Important:** The Apple Shortcut only works when your local server is running. If you restart your Mac, you'll need to start the server again (`node server.js` from the `~/open-brain-mcp` directory). See Step 9 for auto-start setup.

### Step 8: Test Capture

Run your server if it's not already running:

```bash
cd ~/open-brain-mcp && node server.js
```

**Test via terminal first:**

```bash
curl -X POST http://localhost:3333/capture \
  -H "Content-Type: application/json" \
  -H "x-brain-key: your-access-key" \
  -d '{"content": "Sarah mentioned she is thinking about leaving her job to start a consulting business", "source": "test"}'
```

You should get back:

```json
{
  "success": true,
  "id": "some-uuid",
  "created_at": "2026-03-04T...",
  "confirmation": "Captured as person_note — career, consulting | People: Sarah",
  "metadata": { ... }
}
```

**Now test the Apple Shortcut:**
1. Open Shortcuts → run "Capture Thought"
2. Type a thought
3. You should see a notification with the confirmation

**Verify in the database:**

```bash
psql open_brain -c "SELECT content, metadata->>'type' as type, metadata->'topics' as topics FROM thoughts ORDER BY created_at DESC LIMIT 5;"
```

### Step 9: Auto-Start the Server (Optional)

Create a Launch Agent so the server starts automatically when you log in:

```bash
cat > ~/Library/LaunchAgents/com.open-brain.server.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.open-brain.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>$(echo ~/open-brain-mcp/server.js)</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(echo ~/open-brain-mcp)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$(echo ~/open-brain-mcp/server.log)</string>
    <key>StandardErrorPath</key>
    <string>$(echo ~/open-brain-mcp/server.err.log)</string>
</dict>
</plist>
EOF
```

> ⚠️ The `$(which node)` and `$(echo ~)` substitutions will expand when you run the `cat` command. If they don't, manually replace them with the full paths (run `which node` and `echo ~/open-brain-mcp` to get them).

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.open-brain.server.plist
```

To stop it later:

```bash
launchctl unload ~/Library/LaunchAgents/com.open-brain.server.plist
```

---

## Part 4 — MCP Server for AI Clients

### Step 10: Create the MCP Server

This is the bridge that lets Claude, ChatGPT, Cursor, and any MCP-compatible AI client read and write your brain.

Create the file `mcp-server.js`:

```javascript
require("dotenv").config();
const { Pool } = require("pg");
const pgvector = require("pgvector");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const pool = new Pool({ connectionString: DATABASE_URL });
pool.on("connect", async (client) => {
  await pgvector.registerTypes(client);
});

// ─── AI Helpers ───────────────────────────────────────────
async function getEmbedding(text) {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

async function extractMetadata(text) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// ─── MCP Protocol over stdio ─────────────────────────────

const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.5)", default: 0.5 },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", default: 10 },
        type: { type: "string", description: "Filter: observation, task, idea, reference, person_note" },
        topic: { type: "string", description: "Filter by topic tag" },
        person: { type: "string", description: "Filter by person mentioned" },
        days: { type: "number", description: "Only thoughts from the last N days" },
      },
    },
  },
  {
    name: "thought_stats",
    description: "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The thought to capture — a clear, standalone statement",
        },
      },
      required: ["content"],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────

async function handleSearchThoughts({ query, limit = 10, threshold = 0.5 }) {
  const qEmb = await getEmbedding(query);
  const { rows } = await pool.query(
    `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
    [pgvector.toSql(qEmb), threshold, limit, "{}"]
  );
  if (!rows.length) return `No thoughts found matching "${query}".`;

  return rows
    .map((t, i) => {
      const m = t.metadata || {};
      const parts = [
        `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
        `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
        `Type: ${m.type || "unknown"}`,
      ];
      if (m.topics?.length) parts.push(`Topics: ${m.topics.join(", ")}`);
      if (m.people?.length) parts.push(`People: ${m.people.join(", ")}`);
      if (m.action_items?.length) parts.push(`Actions: ${m.action_items.join("; ")}`);
      parts.push(`\n${t.content}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

async function handleListThoughts({ limit = 10, type, topic, person, days }) {
  let sql = `SELECT id, content, metadata, created_at FROM thoughts`;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (type) { conditions.push(`metadata->>'type' = $${idx++}`); params.push(type); }
  if (topic) { conditions.push(`metadata->'topics' ? $${idx++}`); params.push(topic); }
  if (person) { conditions.push(`metadata->'people' ? $${idx++}`); params.push(person); }
  if (days) { conditions.push(`created_at >= now() - interval '${parseInt(days)} days'`); }

  if (conditions.length) sql += ` WHERE ` + conditions.join(" AND ");
  sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
  params.push(parseInt(limit));

  const { rows } = await pool.query(sql, params);
  if (!rows.length) return "No thoughts found.";

  return rows
    .map((t, i) => {
      const m = t.metadata || {};
      const tags = m.topics?.length ? m.topics.join(", ") : "";
      return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " — " + tags : ""})\n   ${t.content}`;
    })
    .join("\n\n");
}

async function handleThoughtStats() {
  const { rows: countRows } = await pool.query("SELECT count(*) FROM thoughts");
  const total = parseInt(countRows[0].count);

  const { rows } = await pool.query(
    "SELECT metadata, created_at FROM thoughts ORDER BY created_at DESC"
  );

  const types = {}, topics = {}, people = {};
  for (const r of rows) {
    const m = r.metadata || {};
    if (m.type) types[m.type] = (types[m.type] || 0) + 1;
    if (Array.isArray(m.topics)) for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
    if (Array.isArray(m.people)) for (const p of m.people) people[p] = (people[p] || 0) + 1;
  }

  const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const lines = [
    `Total thoughts: ${total}`,
    `Date range: ${rows.length ? new Date(rows[rows.length - 1].created_at).toLocaleDateString() + " → " + new Date(rows[0].created_at).toLocaleDateString() : "N/A"}`,
    "", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
  ];
  if (Object.keys(topics).length) {
    lines.push("", "Top topics:");
    for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
  }
  if (Object.keys(people).length) {
    lines.push("", "People mentioned:");
    for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
  }
  return lines.join("\n");
}

async function handleCaptureThought({ content }) {
  const [embedding, metadata] = await Promise.all([
    getEmbedding(content),
    extractMetadata(content),
  ]);

  await pool.query(
    `INSERT INTO thoughts (content, embedding, metadata) VALUES ($1, $2, $3)`,
    [content, pgvector.toSql(embedding), { ...metadata, source: "mcp" }]
  );

  let confirmation = `Captured as ${metadata.type || "thought"}`;
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  if (metadata.people?.length) confirmation += ` | People: ${metadata.people.join(", ")}`;
  if (metadata.action_items?.length) confirmation += ` | Actions: ${metadata.action_items.join("; ")}`;
  return confirmation;
}

// ─── MCP Message Handling ─────────────────────────────────

let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  processBuffer();
});

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

    const len = parseInt(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + len) return;

    const body = buffer.slice(bodyStart, bodyStart + len);
    buffer = buffer.slice(bodyStart + len);

    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      console.error("Parse error:", e);
    }
  }
}

async function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "open-brain", version: "1.0.0" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // no response needed
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS },
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    try {
      let result;
      switch (name) {
        case "search_thoughts": result = await handleSearchThoughts(args); break;
        case "list_thoughts": result = await handleListThoughts(args); break;
        case "thought_stats": result = await handleThoughtStats(); break;
        case "capture_thought": result = await handleCaptureThought(args); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: result }] },
      });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      });
    }
  } else if (msg.id) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
```

### Step 11: Connect to Your AI Clients

**Claude Desktop**

Open `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if it doesn't exist) and add:

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/open-brain-mcp/mcp-server.js"],
      "env": {
        "OPENROUTER_API_KEY": "your-openrouter-key",
        "DATABASE_URL": "postgresql://localhost:5432/open_brain"
      }
    }
  }
}
```

Replace `YOUR_USERNAME` with your actual macOS username.

**VS Code / Copilot / Cursor**

Add to your MCP settings (`.vscode/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "open-brain": {
      "command": "node",
      "args": ["~/open-brain-mcp/mcp-server.js"],
      "env": {
        "OPENROUTER_API_KEY": "your-openrouter-key",
        "DATABASE_URL": "postgresql://localhost:5432/open_brain"
      }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add open-brain -- node ~/open-brain-mcp/mcp-server.js
```

(Set `OPENROUTER_API_KEY` and `DATABASE_URL` in your shell environment first.)

---

## Part 5 — Use It

### From the Apple Shortcut

Trigger your **"Capture Thought"** shortcut from anywhere — keyboard shortcut, menu bar, or Siri:

> "Sarah mentioned she's thinking about leaving her job to start a consulting business"

You'll get a notification:

> 🧠 Open Brain: Captured as person_note — career, consulting | People: Sarah

### From Any AI Client

| Prompt | Tool Used |
|---|---|
| "What did I capture about career changes?" | `search_thoughts` |
| "What did I capture this week?" | `list_thoughts` |
| "How many thoughts do I have?" | `thought_stats` |
| "Find my notes about the API redesign" | `search_thoughts` |
| "Show me my recent ideas" | `list_thoughts` + filter |
| "Who do I mention most?" | `thought_stats` |
| "Save this: decided to move the launch to March 15" | `capture_thought` |
| "Remember that Marcus wants to move to the platform team" | `capture_thought` |

### From the Terminal (Quick Capture)

```bash
# Add a shell alias for fast capture
echo 'brain() { curl -s -X POST http://localhost:3333/capture -H "Content-Type: application/json" -H "x-brain-key: YOUR_KEY" -d "{\"content\": \"$*\", \"source\": \"terminal\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get(\"confirmation\",\"error\"))"; }' >> ~/.zshrc
source ~/.zshrc

# Now just:
brain Sarah mentioned she is thinking about leaving her job
```

---

## Troubleshooting

### PostgreSQL won't start

```bash
brew services restart postgresql@16
# Check logs:
tail -20 /opt/homebrew/var/log/postgresql@16.log
```

### pgvector extension not found

```bash
psql open_brain -c "CREATE EXTENSION vector;"
# If that fails, reinstall pgvector:
brew reinstall pgvector
```

### Server crashes on startup

Check your `.env` file has correct values. Test the database connection:

```bash
psql postgresql://localhost:5432/open_brain -c "SELECT 1;"
```

### Apple Shortcut gets "Could not connect to the server"

- Make sure `node server.js` is running
- Check the URL in the shortcut is `http://localhost:3333/capture`
- Try `http://127.0.0.1:3333/capture` instead

### Search returns no results

- Verify thoughts exist: `psql open_brain -c "SELECT count(*) FROM thoughts;"`
- Try a lower threshold: search with `threshold: 0.3`
- Check OpenRouter has credits: [openrouter.ai/credits](https://openrouter.ai/credits)

### Embeddings fail

Check your OpenRouter key is valid and has credits:

```bash
curl https://openrouter.ai/api/v1/models \
  -H "Authorization: Bearer your-key"
```

---

## Architecture Summary

```
┌──────────────────┐     ┌──────────────────┐
│  Apple Shortcut   │────▶│                  │
│  (text input)     │     │   Express Server  │
└──────────────────┘     │   (localhost:3333) │
                          │                    │
┌──────────────────┐     │   • /capture       │     ┌─────────────────┐
│  Terminal / curl  │────▶│   • /search        │────▶│  PostgreSQL      │
└──────────────────┘     │   • /thoughts      │     │  + pgvector      │
                          │   • /stats         │     │  (localhost:5432) │
                          └────────────────────┘     └─────────────────┘
                                   ▲
┌──────────────────┐               │                  ┌─────────────────┐
│  Claude / GPT /   │──── MCP ─────┘                  │  OpenRouter API  │
│  Cursor / etc.    │     (stdio)                     │  (embeddings +   │
└──────────────────┘                                  │   metadata)      │
                                                      └─────────────────┘
```

**When you capture via Shortcut/terminal:** HTTP POST → Server generates embedding + metadata via OpenRouter → Stores in PostgreSQL → Returns confirmation.

**When an AI searches your brain:** AI calls MCP tool → MCP server generates query embedding → PostgreSQL vector similarity search → Results returned to AI.

Everything runs on your machine. Your data never leaves except for the embedding/metadata API calls to OpenRouter.

---

## Swapping Models Later

Edit the model strings in `server.js` and `mcp-server.js`:

- Embedding model: change `"openai/text-embedding-3-small"` to any model on [openrouter.ai/models](https://openrouter.ai/models) that produces embeddings. If changing dimensions, update the `vector(1536)` column type and recreate the index.
- Metadata model: change `"openai/gpt-4o-mini"` to any chat model.

---

*Adapted from the Open Brain guide by Nate B. Jones for fully local operation.*
