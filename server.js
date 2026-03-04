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
const MAX_THOUGHT_CHARS = 12000;

const pool = new Pool({ connectionString: DATABASE_URL });

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
  const key = req.headers["x-brain-key"] || req.query.key;
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
    res.json({
      status: "ok",
      thoughts: (await pool.query("SELECT count(*) FROM thoughts")).rows[0].count,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ── Capture a thought ─────────────────────────────────────
app.post("/capture", requireKey, async (req, res) => {
  try {
    const { content, source } = req.body;
    const normalizedContent = String(content ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/^[\t ]+/gm, "")
      .replace(/[\t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!normalizedContent) {
      return res.status(400).json({ error: "Content is required" });
    }

    if (normalizedContent.length > MAX_THOUGHT_CHARS) {
      return res.status(400).json({
        error: `Content is too long (${normalizedContent.length} chars). Max allowed is ${MAX_THOUGHT_CHARS}.`,
      });
    }

    const [embedding, metadata] = await Promise.all([
      getEmbedding(normalizedContent),
      extractMetadata(normalizedContent),
    ]);

    const result = await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [normalizedContent, pgvector.toSql(embedding), { ...metadata, source: source || "api" }]
    );

    const meta = metadata;
    let confirmation = `Captured as ${meta.type || "thought"}`;
    if (meta.topics?.length) confirmation += ` — ${meta.topics.join(", ")}`;
    if (meta.people?.length) confirmation += ` | People: ${meta.people.join(", ")}`;
    if (meta.action_items?.length)
      confirmation += ` | Actions: ${meta.action_items.join("; ")}`;

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
