const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const pgvector = require("pgvector");

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
const DATABASE_URL = process.env.DATABASE_URL;
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_THOUGHT_CHARS = 12000;

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
    name: "ancestor_stats",
    description:
      "Get a high-level summary of your entire family tree: total ancestors, countries/regions of origin (with counts), top surnames, earliest and latest birth years, and male/female breakdown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "find_ancestors",
    description:
      "Search the family tree by any combination of name, given name, surname, birth date/year range, birth place, death date/year range, death place, burial place, or sex. Optionally trace a person's lineage up the tree.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Full or partial name to search for",
        },
        given_name: {
          type: "string",
          description: "First/given name to search for (e.g. 'Mary', 'Johann')",
        },
        surname: {
          type: "string",
          description: "Family/surname to search for (e.g. 'Smith', 'Mueller')",
        },
        birth_date: {
          type: "string",
          description: "Full or partial birth date to match (e.g. '1820', 'MAR 1820', '15 MAR 1820')",
        },
        birth_year_from: {
          type: "number",
          description: "Find ancestors born in or after this year (e.g. 1800)",
        },
        birth_year_to: {
          type: "number",
          description: "Find ancestors born in or before this year (e.g. 1850)",
        },
        birth_place: {
          type: "string",
          description: "Full or partial birth place to match (e.g. 'Germany', 'California', 'London')",
        },
        death_date: {
          type: "string",
          description: "Full or partial death date to match (e.g. '1890', 'JUN 1890')",
        },
        death_year_from: {
          type: "number",
          description: "Find ancestors who died in or after this year (e.g. 1860)",
        },
        death_year_to: {
          type: "number",
          description: "Find ancestors who died in or before this year (e.g. 1900)",
        },
        death_place: {
          type: "string",
          description: "Full or partial death place to match (e.g. 'New York', 'England')",
        },
        burial_place: {
          type: "string",
          description: "Full or partial burial place to match",
        },
        sex: {
          type: "string",
          description: "Filter by sex: 'M' for male, 'F' for female",
        },
        lineage: {
          type: "boolean",
          description: "If true, trace ancestors upward from the first match",
          default: false,
        },
        generations: {
          type: "number",
          description: "Max generations to trace when lineage is true (default 10)",
          default: 10,
        },
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

async function handleAncestorStats() {
  const { rows: countRows } = await pool.query("SELECT count(*) FROM ancestors");
  const total = parseInt(countRows[0].count);
  if (!total) return "No ancestors in the family tree yet.";

  const { rows } = await pool.query(
    "SELECT name, surname, sex, birth_date, birth_place, death_date, death_place, burial_place FROM ancestors"
  );

  // Extract country (last comma-separated segment) from place strings
  function extractCountry(place) {
    if (!place) return null;
    const parts = place.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  }

  // Extract 4-digit year from GEDCOM date strings
  function extractYear(dateStr) {
    if (!dateStr) return null;
    const m = dateStr.match(/(\d{4})/);
    return m ? parseInt(m[1], 10) : null;
  }

  const countries = {};
  const surnames = {};
  const sexes = { M: 0, F: 0, unknown: 0 };
  let earliestBirth = Infinity;
  let latestBirth = -Infinity;
  let earliestDeath = Infinity;
  let latestDeath = -Infinity;

  for (const a of rows) {
    // Countries — collect from all place fields, deduplicate per person
    const personCountries = new Set();
    for (const place of [a.birth_place, a.death_place, a.burial_place]) {
      const c = extractCountry(place);
      if (c) personCountries.add(c);
    }
    for (const c of personCountries) countries[c] = (countries[c] || 0) + 1;

    // Surnames
    if (a.surname) surnames[a.surname] = (surnames[a.surname] || 0) + 1;

    // Sex
    if (a.sex === "M" || a.sex === "F") sexes[a.sex]++;
    else sexes.unknown++;

    // Year ranges
    const by = extractYear(a.birth_date);
    if (by) { earliestBirth = Math.min(earliestBirth, by); latestBirth = Math.max(latestBirth, by); }
    const dy = extractYear(a.death_date);
    if (dy) { earliestDeath = Math.min(earliestDeath, dy); latestDeath = Math.max(latestDeath, dy); }
  }

  const sort = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

  const lines = [
    `Total ancestors: ${total}`,
    `Male: ${sexes.M}  |  Female: ${sexes.F}${sexes.unknown ? `  |  Unknown: ${sexes.unknown}` : ""}`,
  ];

  if (earliestBirth !== Infinity) {
    lines.push(`Birth year range: ${earliestBirth} – ${latestBirth === -Infinity ? "?" : latestBirth}`);
  }
  if (earliestDeath !== Infinity) {
    lines.push(`Death year range: ${earliestDeath} – ${latestDeath === -Infinity ? "?" : latestDeath}`);
  }

  const sortedCountries = sort(countries);
  if (sortedCountries.length) {
    lines.push("", `Countries / Regions (${sortedCountries.length}):`);
    for (const [k, v] of sortedCountries) lines.push(`  ${k}: ${v}`);
  }

  const sortedSurnames = sort(surnames).slice(0, 20);
  if (sortedSurnames.length) {
    lines.push("", "Top surnames:");
    for (const [k, v] of sortedSurnames) lines.push(`  ${k}: ${v}`);
  }

  return lines.join("\n");
}

async function handleFindAncestors({ name, given_name, surname, birth_date, birth_year_from, birth_year_to, birth_place, death_date, death_year_from, death_year_to, death_place, burial_place, sex, lineage = false, generations = 10 }) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (name) { conditions.push(`name ILIKE $${idx++}`); params.push(`%${name}%`); }
  if (given_name) { conditions.push(`given_name ILIKE $${idx++}`); params.push(`%${given_name}%`); }
  if (surname) { conditions.push(`surname ILIKE $${idx++}`); params.push(`%${surname}%`); }
  if (birth_date) { conditions.push(`birth_date ILIKE $${idx++}`); params.push(`%${birth_date}%`); }
  if (birth_year_from) { conditions.push(`CAST(substring(birth_date FROM '[0-9]{4}') AS INTEGER) >= $${idx++}`); params.push(birth_year_from); }
  if (birth_year_to) { conditions.push(`CAST(substring(birth_date FROM '[0-9]{4}') AS INTEGER) <= $${idx++}`); params.push(birth_year_to); }
  if (birth_place) { conditions.push(`birth_place ILIKE $${idx++}`); params.push(`%${birth_place}%`); }
  if (death_date) { conditions.push(`death_date ILIKE $${idx++}`); params.push(`%${death_date}%`); }
  if (death_year_from) { conditions.push(`CAST(substring(death_date FROM '[0-9]{4}') AS INTEGER) >= $${idx++}`); params.push(death_year_from); }
  if (death_year_to) { conditions.push(`CAST(substring(death_date FROM '[0-9]{4}') AS INTEGER) <= $${idx++}`); params.push(death_year_to); }
  if (death_place) { conditions.push(`death_place ILIKE $${idx++}`); params.push(`%${death_place}%`); }
  if (burial_place) { conditions.push(`burial_place ILIKE $${idx++}`); params.push(`%${burial_place}%`); }
  if (sex) { conditions.push(`sex = $${idx++}`); params.push(sex.charAt(0).toUpperCase()); }

  if (!conditions.length) return "Please provide at least one search filter (name, given_name, surname, birth_date, birth_year_from/to, birth_place, death_date, death_year_from/to, death_place, burial_place, or sex).";

  const sql = `SELECT * FROM ancestors WHERE ${conditions.join(" AND ")} ORDER BY surname, given_name LIMIT 20`;
  const { rows } = await pool.query(sql, params);

  const filterDesc = [name, given_name, surname, birth_date, birth_year_from, birth_year_to, birth_place, death_date, death_year_from, death_year_to, death_place, burial_place, sex].filter(Boolean).join(", ");
  if (!rows.length) return `No ancestors found matching "${filterDesc}".`;

  if (!lineage) {
    return rows.map((a) => formatAncestor(a)).join("\n\n");
  }

  const person = rows[0];
  const { rows: tree } = await pool.query(
    `SELECT * FROM trace_lineage($1, $2)`,
    [person.id, generations]
  );

  const genLabels = [
    "Self", "Parents", "Grandparents", "Great-grandparents",
    "2x Great-grandparents", "3x Great-grandparents",
  ];

  const grouped = new Map();
  for (const row of tree) {
    if (!grouped.has(row.generation)) grouped.set(row.generation, []);
    grouped.get(row.generation).push(row);
  }

  const lines = [];
  for (const [gen, members] of grouped) {
    const label = gen < genLabels.length ? genLabels[gen] : `${gen - 2}x Great-grandparents`;
    lines.push(`── Generation ${gen} (${label}) ──`);
    for (const m of members) lines.push(formatAncestor(m));
    lines.push("");
  }

  return lines.join("\n");
}

function formatAncestor(a) {
  const parts = [`${a.name}`];
  if (a.sex) parts[0] += ` (${a.sex === "M" ? "Male" : a.sex === "F" ? "Female" : a.sex})`;
  if (a.birth_date || a.birth_place) {
    parts.push(`  Born: ${[a.birth_date, a.birth_place].filter(Boolean).join(", ")}`);
  }
  if (a.death_date || a.death_place) {
    parts.push(`  Died: ${[a.death_date, a.death_place].filter(Boolean).join(", ")}`);
  }
  if (a.burial_place) {
    parts.push(`  Buried: ${a.burial_place}`);
  }
  return parts.join("\n");
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
        case "ancestor_stats":
          result = await handleAncestorStats();
          break;
        case "find_ancestors":
          result = await handleFindAncestors(args);
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
