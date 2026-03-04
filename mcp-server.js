require("dotenv").config();
const { Pool } = require("pg");
const pgvector = require("pgvector");

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const pool = new Pool({ connectionString: DATABASE_URL });

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

  if (type) {
    conditions.push(`metadata->>'type' = $${idx++}`);
    params.push(type);
  }
  if (topic) {
    conditions.push(`metadata->'topics' ? $${idx++}`);
    params.push(topic);
  }
  if (person) {
    conditions.push(`metadata->'people' ? $${idx++}`);
    params.push(person);
  }
  if (days) {
    conditions.push(`created_at >= now() - interval '${parseInt(days)} days'`);
  }

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

  const types = {},
    topics = {},
    people = {};
  for (const r of rows) {
    const m = r.metadata || {};
    if (m.type) types[m.type] = (types[m.type] || 0) + 1;
    if (Array.isArray(m.topics)) for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
    if (Array.isArray(m.people)) for (const p of m.people) people[p] = (people[p] || 0) + 1;
  }

  const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const lines = [
    `Total thoughts: ${total}`,
    `Date range: ${
      rows.length
        ? new Date(rows[rows.length - 1].created_at).toLocaleDateString() +
          " → " +
          new Date(rows[0].created_at).toLocaleDateString()
        : "N/A"
    }`,
    "",
    "Types:",
    ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
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
  if (metadata.action_items?.length)
    confirmation += ` | Actions: ${metadata.action_items.join("; ")}`;
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
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

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
        case "search_thoughts":
          result = await handleSearchThoughts(args);
          break;
        case "list_thoughts":
          result = await handleListThoughts(args);
          break;
        case "thought_stats":
          result = await handleThoughtStats();
          break;
        case "capture_thought":
          result = await handleCaptureThought(args);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
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
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      });
    }
  } else if (msg.id) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}
