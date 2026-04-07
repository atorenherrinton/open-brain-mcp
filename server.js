require("dotenv").config();
const express = require("express");
const pgvector = require("pgvector");
const { spawn } = require("child_process");
const { createPool } = require("./lib/db");

// ─── Config ───────────────────────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;
const PORT = parseInt(process.env.SERVER_PORT || "3333", 10);
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MAX_THOUGHT_CHARS = 12000;

// ─── AI task dispatch config ──────────────────────────────
const TASK_WEBHOOK_SECRET = process.env.TASK_WEBHOOK_SECRET;
const HOST_WORKSPACES_ROOT = process.env.HOST_WORKSPACES_ROOT || "";
const CONTAINER_WORKSPACES_ROOT = process.env.CONTAINER_WORKSPACES_ROOT || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const pool = createPool();

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
      .trim()
      .replace(/\s+/g, " ");

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

// ─── AI task dispatch ─────────────────────────────────────
//
// Supabase database webhooks call POST /webhooks/task-for-ai whenever a task
// row is inserted or updated. Rows where assignee='ai' AND status='todo' are
// queued and run serially through `claude -p` with cwd=working_dir. Each
// invocation is a fresh, stateless Claude Code session — no clearing needed.

// Translate a host filesystem path (as stored in the DB) into the path that
// the same files are mounted at inside this container. If the path doesn't
// live under the configured host root, return it unchanged.
function translateWorkingDir(hostPath) {
  if (!hostPath) return null;
  if (HOST_WORKSPACES_ROOT && CONTAINER_WORKSPACES_ROOT && hostPath.startsWith(HOST_WORKSPACES_ROOT)) {
    return CONTAINER_WORKSPACES_ROOT + hostPath.slice(HOST_WORKSPACES_ROOT.length);
  }
  return hostPath;
}

function buildPrompt(task) {
  const lines = [
    "You are an autonomous Claude Code agent dispatched by the Open Brain task system.",
    "",
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
  ];
  if (task.description) lines.push(`Description: ${task.description}`);
  if (task.priority) lines.push(`Priority: ${task.priority}`);
  if (task.due_date) lines.push(`Due: ${task.due_date}`);
  lines.push(
    "",
    "Complete this task in the current working directory.",
    "",
    "When the work is done, commit your changes on the current branch with a clear",
    "message describing what you did, then push to the tracking remote. Use a single",
    "commit unless the work is genuinely independent. Do NOT force-push, do NOT",
    "rebase published history, and do NOT switch branches.",
    "",
    "Task state (in_progress/done) is managed by the dispatcher — you do not need",
    "to update it yourself. Just do the work, commit, push, and exit cleanly. If the",
    "work is impossible or unsafe to push, write a brief explanation to stderr and",
    "exit with a non-zero code (the dispatcher will leave the task in_progress and",
    "save your stderr as a task note).",
  );
  return lines.join("\n");
}

// Update a task row via Supabase REST API. We can't use the lib/db.js postgres
// pool from this container (its connection string is unset for this deployment),
// and we don't want to require Open Brain MCP inside the container, so REST is
// the simplest path. service_role key is required to write tasks.
async function updateTaskRest(taskId, patch) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set to manage task state");
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`supabase task update failed: ${res.status} ${body}`);
  }
}

async function addTaskNoteRest(taskId, content) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  await fetch(`${SUPABASE_URL}/rest/v1/task_notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ task_id: taskId, content, type: "note" }),
  }).catch((err) => console.error(`[ai-dispatch] failed to add task note: ${err.message}`));
}

// Serial queue: one Claude invocation at a time. Tracks in-flight task IDs so
// repeated webhook deliveries for the same row are deduped.
const taskQueue = [];
const inFlight = new Set();
let workerRunning = false;

function enqueueTask(task) {
  if (inFlight.has(task.id)) {
    console.log(`[ai-dispatch] task ${task.id} already queued/running, skipping`);
    return;
  }
  inFlight.add(task.id);
  taskQueue.push(task);
  console.log(`[ai-dispatch] enqueued task ${task.id} "${task.title}" (queue depth: ${taskQueue.length})`);
  if (!workerRunning) runWorker();
}

async function runWorker() {
  workerRunning = true;
  while (taskQueue.length) {
    const task = taskQueue.shift();
    try {
      await dispatchTask(task);
    } catch (err) {
      console.error(`[ai-dispatch] task ${task.id} failed:`, err);
    } finally {
      inFlight.delete(task.id);
    }
  }
  workerRunning = false;
}

// Run `git` in the given working dir and capture stdout/stderr.
function gitCapture(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Tracked files that tooling regenerates as a side effect of running (e.g.
// `next build`/typecheck rewrites next-env.d.ts even when nothing meaningful
// changed). If these are the only "uncommitted" changes after the agent exits,
// they're noise — discard them before verifying so the task isn't failed for
// work the agent never intended to do.
const AUTOGENERATED_TRACKED_FILES = [
  "src/frontend/next-env.d.ts",
];

// Verify a dispatched agent actually committed and pushed everything before
// we mark the task done. Returns { ok: true } or { ok: false, reason }.
async function verifyWorkPushed(cwd) {
  // Discard known auto-generated tracked files first so they don't trip the
  // "uncommitted changes" check below. We only checkout paths that actually
  // show up as modified — `git checkout --` on a clean path is a no-op but
  // would still spam the logs.
  for (const path of AUTOGENERATED_TRACKED_FILES) {
    const probe = await gitCapture(cwd, ["status", "--porcelain", "--", path]);
    if (probe.code === 0 && probe.stdout.trim() !== "") {
      await gitCapture(cwd, ["checkout", "--", path]);
    }
  }

  // 1. No uncommitted changes to TRACKED files? We pass --untracked-files=no
  // because the in-container Claude Code creates a `.claude/` project-state
  // directory in the cwd as a side effect — that's untracked noise we don't
  // care about, not work the agent forgot to commit.
  const status = await gitCapture(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) {
    return { ok: false, reason: `git status failed (exit ${status.code}): ${status.stderr.trim()}` };
  }
  if (status.stdout.trim() !== "") {
    return {
      ok: false,
      reason: `working tree has uncommitted changes to tracked files after agent exit:\n${status.stdout.trim()}`,
    };
  }

  // 2. Branch not ahead of upstream? (i.e. nothing committed-but-unpushed)
  const ahead = await gitCapture(cwd, ["rev-list", "--count", "@{u}..HEAD"]);
  if (ahead.code !== 0) {
    return {
      ok: false,
      reason: `git rev-list @{u}..HEAD failed (exit ${ahead.code}): ${ahead.stderr.trim()}`,
    };
  }
  const aheadCount = parseInt(ahead.stdout.trim(), 10);
  if (Number.isNaN(aheadCount) || aheadCount > 0) {
    return {
      ok: false,
      reason: `local branch is ${aheadCount} commit(s) ahead of upstream — agent failed to push`,
    };
  }

  return { ok: true };
}

async function dispatchTask(task) {
  const cwd = translateWorkingDir(task.working_dir);
  if (!cwd) throw new Error("task has no working_dir");

  // Mark in_progress so the same row doesn't immediately re-trigger via UPDATE
  // and so the user can see live state in the dashboard.
  await updateTaskRest(task.id, { status: "in_progress" });

  const prompt = buildPrompt(task);
  console.log(`[ai-dispatch] running claude for task ${task.id} in ${cwd}`);

  let stderrTail = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        CLAUDE_BIN,
        ["-p", prompt, "--dangerously-skip-permissions"],
        { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
      );
      child.stdout.on("data", (b) => process.stdout.write(`[task ${task.id}] ${b}`));
      child.stderr.on("data", (b) => {
        stderrTail = (stderrTail + b.toString()).slice(-2000);
        process.stderr.write(`[task ${task.id}] ${b}`);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`claude exited with code ${code}`));
      });
    });
  } catch (err) {
    // Leave the task at in_progress so it doesn't auto-retry, and record why.
    await addTaskNoteRest(task.id, `AI dispatch failed: ${err.message}\n\nstderr tail:\n${stderrTail}`);
    throw err;
  }

  // Don't trust claude's exit code alone — `claude -p` exits 0 whenever it
  // produces a final response, even if that response is "I gave up because
  // git push failed." Verify the work actually landed on the remote before
  // marking the task done. Two checks:
  //   1. Working tree must be clean (no leftover uncommitted changes).
  //   2. The local branch must not be ahead of its upstream (everything
  //      committed in this run has been pushed).
  // If either check fails, leave the task at in_progress and record why.
  const verification = await verifyWorkPushed(cwd);
  if (!verification.ok) {
    await addTaskNoteRest(
      task.id,
      `AI dispatch produced unverified work — leaving task at in_progress for human review.\n\n${verification.reason}\n\nstderr tail:\n${stderrTail}`
    );
    throw new Error(`task ${task.id} failed verification: ${verification.reason}`);
  }

  await updateTaskRest(task.id, { status: "done" });
  console.log(`[ai-dispatch] task ${task.id} completed (verified pushed)`);
}

// Supabase database webhook receiver.
// Expected payload (Supabase "Database Webhook" format):
//   { type: "INSERT"|"UPDATE"|"DELETE", table, record, old_record, schema }
app.post("/webhooks/task-for-ai", (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!TASK_WEBHOOK_SECRET || secret !== TASK_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "invalid webhook secret" });
  }

  const { type, record, old_record } = req.body || {};
  if (type === "DELETE" || !record) return res.json({ ok: true, ignored: "not an upsert" });

  // A task is "active" (eligible for dispatch) if it's assigned to ai and
  // its status is either todo or in_progress. Including in_progress lets
  // users hand off mid-flight tasks to the agent.
  const isActive = (r) => r && r.assignee === "ai" && (r.status === "todo" || r.status === "in_progress");
  if (!isActive(record)) return res.json({ ok: true, ignored: "not an ai task in todo/in_progress" });

  // For UPDATEs, only fire when the row *newly* enters the active state.
  // This prevents two kinds of loops:
  //   1. Our own dispatcher writes status=in_progress before spawning Claude;
  //      that UPDATE would otherwise re-fire the webhook.
  //   2. Unrelated edits (e.g. priority bump) on an already-active row would
  //      otherwise re-dispatch the same task.
  if (type === "UPDATE" && isActive(old_record)) {
    return res.json({ ok: true, ignored: "already active" });
  }

  enqueueTask({
    id: record.id,
    title: record.title,
    description: record.description,
    priority: record.priority,
    due_date: record.due_date,
    working_dir: record.working_dir,
  });

  res.json({ ok: true, queued: record.id });
});

// Admin endpoint: re-enqueue all assignee=ai status=todo tasks from the
// database into the in-memory queue. Useful after a dispatcher restart
// (the queue is in-memory and not persisted) or when the loop-guard has
// caused webhooks to be silently ignored. Same auth as the webhook.
//
// Optional JSON body: { project_id?: string } to scope to one project.
app.post("/admin/dispatch-pending", async (req, res) => {
  const secret = req.headers["x-webhook-secret"];
  if (!TASK_WEBHOOK_SECRET || secret !== TASK_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "invalid webhook secret" });
  }
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return res.status(500).json({ error: "SUPABASE_URL and SUPABASE_SECRET_KEY required" });
  }

  const projectId = req.body?.project_id;
  const params = new URLSearchParams({
    select: "id,title,description,priority,due_date,working_dir",
    assignee: "eq.ai",
    status: "eq.todo",
  });
  if (projectId) params.set("project_id", `eq.${projectId}`);

  let tasks;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tasks?${params}`, {
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      },
    });
    if (!r.ok) throw new Error(`supabase ${r.status} ${await r.text().catch(() => "")}`);
    tasks = await r.json();
  } catch (err) {
    return res.status(502).json({ error: `failed to read tasks: ${err.message}` });
  }

  let queued = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (!t.working_dir) {
      console.log(`[admin] skipping task ${t.id} (no working_dir)`);
      skipped++;
      continue;
    }
    if (inFlight.has(t.id)) {
      skipped++;
      continue;
    }
    enqueueTask(t);
    queued++;
  }

  console.log(`[admin] dispatch-pending: queued=${queued} skipped=${skipped} total=${tasks.length}`);
  res.json({ ok: true, queued, skipped, total: tasks.length });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🧠 Open Brain server running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
