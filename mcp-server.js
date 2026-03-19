const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const pgvector = require("pgvector");
const { createPool } = require("./lib/db");

const envPath = path.resolve(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const parsed = dotenv.parse(fs.readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_THOUGHT_CHARS = 12000;

const pool = createPool();

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

let transportMode = "unknown"; // "framed" | "line" | "unknown"

function send(msg) {
  const payload = JSON.stringify(msg);

  if (transportMode === "line") {
    process.stdout.write(payload + "\n");
    return;
  }

  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header + payload);
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
  {
    name: "set_personal_info",
    description:
      "Save or update a piece of personal information. Use this to store details like name, birthday, address, preferences, etc.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The info key, e.g. 'full_name', 'birthday', 'favorite_color'" },
        value: { type: "string", description: "The value to store" },
        category: { type: "string", description: "Category for grouping, e.g. 'identity', 'preferences', 'contact', 'health' (default: 'general')", default: "general" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_personal_info",
    description:
      "Retrieve a specific piece of personal information by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The info key to look up" },
      },
      required: ["key"],
    },
  },
  {
    name: "list_personal_info",
    description:
      "List all stored personal information, optionally filtered by category.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category (e.g. 'identity', 'preferences', 'contact')" },
      },
    },
  },
  {
    name: "search_personal_info",
    description:
      "Search personal information by meaning. Use this when the user asks about their details and you're not sure of the exact key.",
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
    name: "delete_personal_info",
    description:
      "Delete a piece of personal information by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The info key to delete" },
      },
      required: ["key"],
    },
  },
  {
    name: "connect_info_to_thoughts",
    description:
      "Find thoughts related to a piece of personal info. Great for brainstorming — e.g. connect your resume, goals, or skills to captured thoughts.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The personal info key to match against thoughts (e.g. 'resume', 'goals', 'skills')" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.3)", default: 0.3 },
      },
      required: ["key"],
    },
  },
  {
    name: "connect_thought_to_info",
    description:
      "Find personal info related to a thought. Use a thought ID or a search query to find which personal details connect to a captured thought.",
    inputSchema: {
      type: "object",
      properties: {
        thought_id: { type: "string", description: "UUID of the thought to match" },
        query: { type: "string", description: "Search query to find the thought first, then match personal info" },
        limit: { type: "number", description: "Max results (default 10)", default: 10 },
        threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.3)", default: 0.3 },
      },
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
  const normalizedContent = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[\t ]+/gm, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalizedContent) {
    throw new Error("Thought content cannot be empty.");
  }

  if (normalizedContent.length > MAX_THOUGHT_CHARS) {
    throw new Error(
      `Thought is too long (${normalizedContent.length} chars). Max allowed is ${MAX_THOUGHT_CHARS}.`
    );
  }

  const [embedding, metadata] = await Promise.all([
    getEmbedding(normalizedContent),
    extractMetadata(normalizedContent),
  ]);

  await pool.query(
    `INSERT INTO thoughts (content, embedding, metadata) VALUES ($1, $2, $3)`,
    [normalizedContent, pgvector.toSql(embedding), { ...metadata, source: "mcp" }]
  );

  let confirmation = `Captured as ${metadata.type || "thought"}`;
  if (metadata.topics?.length) confirmation += ` — ${metadata.topics.join(", ")}`;
  if (metadata.people?.length) confirmation += ` | People: ${metadata.people.join(", ")}`;
  if (metadata.action_items?.length)
    confirmation += ` | Actions: ${metadata.action_items.join("; ")}`;
  return confirmation;
}

// ─── Personal Info Handlers ──────────────────────────────

async function handleSetPersonalInfo({ key, value, category = "general" }) {
  if (!key || !value) throw new Error("Both key and value are required.");

  const embeddingText = `${key}: ${value}`;
  const embedding = await getEmbedding(embeddingText);

  const { rows } = await pool.query(
    `INSERT INTO personal_info (key, value, category, embedding)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           category = COALESCE(EXCLUDED.category, personal_info.category),
           embedding = EXCLUDED.embedding
     RETURNING key, value, category`,
    [key.toLowerCase().trim(), value.trim(), category.toLowerCase().trim(), pgvector.toSql(embedding)]
  );

  const row = rows[0];
  return `Saved: ${row.key} = "${row.value}" (${row.category})`;
}

async function handleSearchPersonalInfo({ query, limit = 10, threshold = 0.5 }) {
  const qEmb = await getEmbedding(query);
  const { rows } = await pool.query(
    `SELECT * FROM match_personal_info($1, $2, $3)`,
    [pgvector.toSql(qEmb), threshold, limit]
  );
  if (!rows.length) return `No personal info found matching "${query}".`;

  return rows
    .map((r, i) => `${i + 1}. [${r.category}] ${r.key}: ${r.value} (${(r.similarity * 100).toFixed(1)}% match)`)
    .join("\n");
}

async function handleGetPersonalInfo({ key }) {
  if (!key) throw new Error("Key is required.");

  const { rows } = await pool.query(
    `SELECT key, value, category, updated_at FROM personal_info WHERE key = $1`,
    [key.toLowerCase().trim()]
  );

  if (!rows.length) return `No personal info found for "${key}".`;

  const row = rows[0];
  return `${row.key}: ${row.value} (${row.category}) — updated ${new Date(row.updated_at).toLocaleDateString()}`;
}

async function handleListPersonalInfo({ category } = {}) {
  let sql = `SELECT key, value, category, updated_at FROM personal_info`;
  const params = [];

  if (category) {
    sql += ` WHERE category = $1`;
    params.push(category.toLowerCase().trim());
  }
  sql += ` ORDER BY category, key`;

  const { rows } = await pool.query(sql, params);
  if (!rows.length) return category ? `No personal info found in category "${category}".` : "No personal info stored yet.";

  let currentCat = "";
  const lines = [];
  for (const row of rows) {
    if (row.category !== currentCat) {
      currentCat = row.category;
      lines.push(`\n[${currentCat}]`);
    }
    lines.push(`  ${row.key}: ${row.value}`);
  }
  return lines.join("\n").trim();
}

async function handleDeletePersonalInfo({ key }) {
  if (!key) throw new Error("Key is required.");

  const { rowCount } = await pool.query(
    `DELETE FROM personal_info WHERE key = $1`,
    [key.toLowerCase().trim()]
  );

  return rowCount ? `Deleted "${key}".` : `No personal info found for "${key}".`;
}

// ─── Cross-Reference Handlers ────────────────────────────

async function handleConnectInfoToThoughts({ key, limit = 10, threshold = 0.3 }) {
  if (!key) throw new Error("Personal info key is required.");

  const { rows } = await pool.query(
    `SELECT * FROM match_thoughts_by_personal_info($1, $2, $3, $4)`,
    [key.toLowerCase().trim(), threshold, limit, "{}"]
  );

  if (!rows.length) return `No thoughts found related to personal info "${key}".`;

  // Include the personal info context at the top
  const { rows: infoRows } = await pool.query(
    `SELECT key, value, category FROM personal_info WHERE key = $1`,
    [key.toLowerCase().trim()]
  );

  const lines = [];
  if (infoRows.length) {
    const info = infoRows[0];
    lines.push(`Connecting [${info.category}] ${info.key}: ${info.value}`, "");
    lines.push(`--- ${rows.length} related thought(s) ---`, "");
  }

  for (const [i, t] of rows.entries()) {
    const m = t.metadata || {};
    const parts = [
      `${i + 1}. (${(t.similarity * 100).toFixed(1)}% match) [${new Date(t.created_at).toLocaleDateString()}]`,
    ];
    if (m.type) parts[0] += ` (${m.type})`;
    if (m.topics?.length) parts.push(`   Topics: ${m.topics.join(", ")}`);
    parts.push(`   ${t.content}`);
    lines.push(parts.join("\n"));
  }

  return lines.join("\n");
}

async function handleConnectThoughtToInfo({ thought_id, query, limit = 10, threshold = 0.3 }) {
  if (!thought_id && !query) throw new Error("Either thought_id or query is required.");

  let targetId = thought_id;
  let thoughtContent = "";

  // If query provided, find the best matching thought first
  if (!targetId && query) {
    const qEmb = await getEmbedding(query);
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts($1, $2, $3, $4)`,
      [pgvector.toSql(qEmb), 0.3, 1, "{}"]
    );
    if (!rows.length) return `No thought found matching "${query}".`;
    targetId = rows[0].id;
    thoughtContent = rows[0].content;
  }

  // Get thought content if we only have the ID
  if (!thoughtContent) {
    const { rows } = await pool.query(
      `SELECT content FROM thoughts WHERE id = $1`,
      [targetId]
    );
    if (!rows.length) return `Thought "${targetId}" not found.`;
    thoughtContent = rows[0].content;
  }

  const { rows } = await pool.query(
    `SELECT * FROM match_personal_info_by_thought($1, $2, $3)`,
    [targetId, threshold, limit]
  );

  if (!rows.length) return `No personal info found related to this thought.`;

  const lines = [
    `Thought: ${thoughtContent}`,
    "",
    `--- ${rows.length} related personal info ---`,
    "",
  ];

  for (const [i, r] of rows.entries()) {
    lines.push(`${i + 1}. [${r.category}] ${r.key}: ${r.value} (${(r.similarity * 100).toFixed(1)}% match)`);
  }

  return lines.join("\n");
}

// ─── MCP Message Handling ─────────────────────────────────

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

function processRawMessage(raw, source = "unknown") {
  const trimmed = raw.trim();
  if (!trimmed) return;

  if (transportMode === "unknown") {
    if (source === "line") transportMode = "line";
    if (source === "framed") transportMode = "framed";
  }

  try {
    handleMessage(JSON.parse(trimmed));
  } catch (e) {
    console.error("Parse error:", e);
  }
}

function processBuffer() {
  while (inputBuffer.length > 0) {
    const headerEndCrlf = inputBuffer.indexOf("\r\n\r\n");
    const headerEndLf = inputBuffer.indexOf("\n\n");

    let headerEnd = -1;
    let delimiterLength = 0;

    if (headerEndCrlf !== -1 && (headerEndLf === -1 || headerEndCrlf < headerEndLf)) {
      headerEnd = headerEndCrlf;
      delimiterLength = 4;
    } else if (headerEndLf !== -1) {
      headerEnd = headerEndLf;
      delimiterLength = 2;
    }

    if (headerEnd === -1) {
      const newline = inputBuffer.indexOf("\n");
      if (newline === -1) break;

      const line = inputBuffer.slice(0, newline).toString("utf8");
      inputBuffer = inputBuffer.slice(newline + 1);
      processRawMessage(line, "line");
      continue;
    }

    const headerText = inputBuffer.slice(0, headerEnd).toString("utf8");
    const match = headerText.match(/content-length\s*:\s*(\d+)/i);

    if (!match) {
      const maybeJson = inputBuffer.slice(0, headerEnd).toString("utf8");
      inputBuffer = inputBuffer.slice(headerEnd + delimiterLength);
      processRawMessage(maybeJson, "line");
      continue;
    }

    if (transportMode === "unknown") {
      transportMode = "framed";
    }

    const contentLength = parseInt(match[1], 10);
    const messageStart = headerEnd + delimiterLength;
    const messageEnd = messageStart + contentLength;

    if (inputBuffer.length < messageEnd) break;

    const payload = inputBuffer.slice(messageStart, messageEnd).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEnd);
    processRawMessage(payload, "framed");
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
        case "set_personal_info":
          result = await handleSetPersonalInfo(args);
          break;
        case "get_personal_info":
          result = await handleGetPersonalInfo(args);
          break;
        case "search_personal_info":
          result = await handleSearchPersonalInfo(args);
          break;
        case "list_personal_info":
          result = await handleListPersonalInfo(args);
          break;
        case "delete_personal_info":
          result = await handleDeletePersonalInfo(args);
          break;
        case "connect_info_to_thoughts":
          result = await handleConnectInfoToThoughts(args);
          break;
        case "connect_thought_to_info":
          result = await handleConnectThoughtToInfo(args);
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
