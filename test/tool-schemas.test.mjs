/**
 * Tool schema and input validation tests.
 *
 * Validates that every registered MCP tool has correct Zod schemas,
 * required/optional fields, enum constraints, and annotations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(__dirname, "..", "supabase", "functions", "open-brain", "index.ts");

async function readIndex() {
  return await fs.readFile(indexPath, "utf8");
}

function sliceTool(content, toolName, length = 3000) {
  const needle = `"${toolName}"`;
  const idx = content.indexOf(`registerTool(\n    ${needle}`);
  if (idx === -1) {
    // Try alternate format
    const idx2 = content.indexOf(`registerTool(\n    "${toolName}"`);
    assert.ok(idx2 !== -1, `Expected to find tool: ${toolName}`);
    return content.slice(idx2, idx2 + length);
  }
  return content.slice(idx, idx + length);
}

// ─── Read-only annotations ─────────────────────────────────────────────

const READ_ONLY_TOOLS = [
  "version", "whoami", "server_info", "health",
  "search_thoughts", "list_thoughts", "thought_stats",
  "get_personal_info", "search_personal_info", "list_personal_info",
  "get_project_bundle", "get_project", "list_projects", "search_projects",
  "get_task", "get_task_bundle", "list_tasks", "search_tasks",
  "list_task_notes", "search_task_notes",
  "connect_info_to_thoughts", "connect_thought_to_info",
];

for (const tool of READ_ONLY_TOOLS) {
  test(`${tool} has readOnlyHint annotation`, async () => {
    const content = await readIndex();
    const segment = sliceTool(content, tool);
    assert.match(segment, /readOnlyHint:\s*true/, `${tool} should have readOnlyHint: true`);
  });
}

const MUTATING_TOOLS = [
  "capture_thought", "delete_thought", "prune_thoughts",
  "set_personal_info", "delete_personal_info",
  "create_project", "update_project",
  "create_task", "update_task", "delete_task", "bulk_delete_tasks", "bulk_update_tasks",
  "add_task_note", "update_task_note", "delete_task_note",
];

for (const tool of MUTATING_TOOLS) {
  test(`${tool} does NOT have readOnlyHint annotation`, async () => {
    const content = await readIndex();
    const segment = sliceTool(content, tool, 500);
    assert.ok(!segment.includes("readOnlyHint"), `${tool} should not have readOnlyHint`);
  });
}

// ─── Schema field validation ───────────────────────────────────────────

test("capture_thought requires content as string", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "capture_thought");
  assert.match(segment, /content:\s*z\.string\(\)/);
});

test("set_personal_info requires key and value, category is optional", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "set_personal_info");
  assert.match(segment, /key:\s*z\.string\(\)/);
  assert.match(segment, /value:\s*z\.string\(\)/);
  assert.match(segment, /category:\s*z\.string\(\)\.optional\(\)/);
});

test("create_task requires title, optional description/priority/due_date/project_id", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_task");
  assert.match(segment, /title:\s*z\.string\(\)/);
  assert.match(segment, /description:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /priority:\s*z\.enum\(TASK_PRIORITIES\)\.optional\(\)/);
  assert.match(segment, /due_date:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /project_id:\s*z\.string\(\)\.optional\(\)/);
});

test("update_task requires task_id, all other fields optional", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task");
  assert.match(segment, /task_id:\s*z\.string\(\)/);
  assert.match(segment, /title:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /status:\s*z\.enum\(TASK_STATUSES\)\.optional\(\)/);
  assert.match(segment, /priority:\s*z\.enum\(TASK_PRIORITIES\)\.optional\(\)/);
});

test("bulk_delete_tasks requires task_ids array with min 1 max 50", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "bulk_delete_tasks");
  assert.match(segment, /task_ids:\s*z\.array\(z\.string\(\)\)\.min\(1\)\.max\(50\)/);
});

test("bulk_update_tasks requires task_ids array, optional status and priority", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "bulk_update_tasks");
  assert.match(segment, /task_ids:\s*z\.array\(z\.string\(\)\)\.min\(1\)\.max\(50\)/);
  assert.match(segment, /status:\s*z\.enum\(TASK_STATUSES\)\.optional\(\)/);
  assert.match(segment, /priority:\s*z\.enum\(TASK_PRIORITIES\)\.optional\(\)/);
});

test("add_task_note requires task_id and content, optional type enum", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_task_note");
  assert.match(segment, /task_id:\s*z\.string\(\)/);
  assert.match(segment, /content:\s*z\.string\(\)/);
  assert.match(segment, /type:\s*z\.enum\(TASK_NOTE_TYPES\)\.optional\(\)/);
});

test("update_task_note requires note_id, optional content and type", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task_note");
  assert.match(segment, /note_id:\s*z\.string\(\)/);
  assert.match(segment, /content:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /type:\s*z\.enum\(TASK_NOTE_TYPES\)\.optional\(\)/);
});

test("search_thoughts has query, optional limit and threshold", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_thoughts");
  assert.match(segment, /query:\s*z\.string\(\)/);
  assert.match(segment, /limit:\s*z\.number\(\)\.optional\(\)/);
  assert.match(segment, /threshold:\s*z\.number\(\)\.optional\(\)/);
});

test("list_thoughts has all optional filter fields", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_thoughts");
  assert.match(segment, /limit:\s*z\.number\(\)\.optional\(\)/);
  assert.match(segment, /type:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /topic:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /person:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /days:\s*z\.number\(\)\.optional\(\)/);
});

test("get_project_bundle has project_id required, optional include_done/task_limit/note_limit", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_project_bundle");
  assert.match(segment, /project_id:\s*z\.string\(\)/);
  assert.match(segment, /include_done:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(segment, /task_limit:\s*z\.number\(\)\.optional\(\)/);
  assert.match(segment, /note_limit:\s*z\.number\(\)\.optional\(\)/);
});

test("create_project requires name, optional description/repo_url", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_project");
  assert.match(segment, /name:\s*z\.string\(\)/);
  assert.match(segment, /description:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /repo_url:\s*z\.string\(\)\.optional\(\)/);
});

test("update_project requires project_id, optional name/description/repo_url/status", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_project");
  assert.match(segment, /project_id:\s*z\.string\(\)/);
  assert.match(segment, /name:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /status:\s*z\.enum\(PROJECT_STATUSES\)\.optional\(\)/);
});

test("connect_thought_to_info accepts thought_id or query", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "connect_thought_to_info");
  assert.match(segment, /thought_id:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /query:\s*z\.string\(\)\.optional\(\)/);
});

test("list_tasks has comprehensive filter options", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_tasks", 2000);
  assert.match(segment, /status:\s*z\.enum\(TASK_STATUSES\)\.optional\(\)/);
  assert.match(segment, /priority:\s*z\.enum\(TASK_PRIORITIES\)\.optional\(\)/);
  assert.match(segment, /project_id:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /include_done:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(segment, /include_archived:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(segment, /updated_since:\s*z\.string\(\)\.optional\(\)/);
});

test("delete_thought requires thought_id", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_thought");
  assert.match(segment, /thought_id:\s*z\.string\(\)/);
});

test("prune_thoughts requires older_than_days, optional type/topic/dry_run", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts");
  assert.match(segment, /older_than_days:\s*z\.number\(\)\.min\(1\)/);
  assert.match(segment, /type:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /topic:\s*z\.string\(\)\.optional\(\)/);
  assert.match(segment, /dry_run:\s*z\.boolean\(\)\.optional\(\)/);
});
