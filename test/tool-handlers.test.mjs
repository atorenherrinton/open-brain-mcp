/**
 * Tool handler logic tests.
 *
 * Validates handler patterns: input normalization, NOT_FOUND handling,
 * error throwing, conditional updates, default values, and data flow.
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
    const idx2 = content.indexOf(`registerTool(\n    "${toolName}"`);
    assert.ok(idx2 !== -1, `Expected to find tool: ${toolName}`);
    return content.slice(idx2, idx2 + length);
  }
  return content.slice(idx, idx + length);
}

function sliceFrom(content, needle, length = 3000) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `Expected to find: ${needle}`);
  return content.slice(idx, idx + length);
}

// ─── Input normalization ───────────────────────────────────────────────

test("set_personal_info lowercases and trims key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "set_personal_info");
  assert.match(segment, /key\.toLowerCase\(\)\.trim\(\)/, "Should lowercase and trim key");
});

test("set_personal_info lowercases and trims category, defaults to general", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "set_personal_info");
  assert.match(segment, /category \|\| "general"/, "Should default category to general");
});

test("get_personal_info lowercases and trims key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_personal_info");
  assert.match(segment, /key\.toLowerCase\(\)\.trim\(\)/, "Should lowercase and trim key");
});

test("delete_personal_info lowercases and trims key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_personal_info");
  assert.match(segment, /key\.toLowerCase\(\)\.trim\(\)/, "Should lowercase and trim key");
});

test("create_task trims title", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_task");
  assert.match(segment, /title\.trim\(\)/, "Should trim title");
});

test("create_task defaults priority to medium", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_task");
  assert.match(segment, /priority \|\| "medium"/, "Should default priority to medium");
});

test("create_task validates priority against TASK_PRIORITIES", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_task");
  assert.match(segment, /TASK_PRIORITIES\.includes/, "Should validate priority");
  assert.match(segment, /Invalid priority/, "Should throw on invalid priority");
});

test("add_task_note defaults type to note", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_task_note");
  assert.match(segment, /type \|\| "note"/, "Should default type to note");
});

test("add_task_note trims content", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_task_note");
  assert.match(segment, /content\.trim\(\)/, "Should trim content");
});

test("create_project trims name", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "create_project");
  assert.match(segment, /name\.trim\(\)/, "Should trim name");
});

// ─── NOT_FOUND handling ────────────────────────────────────────────────

test("get_personal_info returns message when key not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_personal_info");
  assert.match(segment, /No personal info found for/, "Should return not-found message");
});

test("get_task returns message when task not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_task");
  assert.match(segment, /No task found with ID/, "Should return not-found message");
});

test("update_task returns message when task not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task");
  assert.match(segment, /No task found with ID/, "Should return not-found message");
});

test("delete_task returns message when task not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_task");
  assert.match(segment, /No task found with ID/, "Should return not-found message");
});

test("update_task_note returns message when note not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task_note");
  assert.match(segment, /No note found with ID/, "Should return not-found message");
});

test("delete_task_note returns message when note not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_task_note");
  assert.match(segment, /No note found with ID/, "Should return not-found message");
});

test("get_project returns message when project not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_project");
  assert.match(segment, /No project found with ID/, "Should return not-found message");
});

test("update_project returns message when project not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_project");
  assert.match(segment, /No project found with ID/, "Should return not-found message");
});

test("bulk_delete_tasks returns message when no matching tasks", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "bulk_delete_tasks");
  assert.match(segment, /No matching tasks found to delete/, "Should return not-found message");
});

test("bulk_update_tasks returns message when no matching tasks", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "bulk_update_tasks");
  assert.match(segment, /No matching tasks found to update/, "Should return not-found message");
});

// ─── Empty result handling ─────────────────────────────────────────────

test("list_tasks returns message when no tasks found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_tasks", 4000);
  assert.match(segment, /No tasks found\./, "Should return empty message");
});

test("search_tasks returns message when no matches", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_tasks", 3000);
  assert.match(segment, /No tasks found matching/, "Should return no-match message");
});

test("list_projects returns message when no projects found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_projects", 3000);
  assert.match(segment, /No projects found\./, "Should return empty message");
});

test("search_projects returns message when no matches", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_projects");
  assert.match(segment, /No projects found matching/, "Should return no-match message");
});

test("list_task_notes returns message when no notes found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_task_notes");
  assert.match(segment, /No notes found for task/, "Should return empty message");
});

test("search_task_notes returns message when no matches", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_task_notes");
  assert.match(segment, /No task notes found matching/, "Should return no-match message");
});

test("list_personal_info handles both category and no-category empty states", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_personal_info");
  assert.match(segment, /No personal info in category/, "Should handle filtered empty");
  assert.match(segment, /No personal info stored yet/, "Should handle unfiltered empty");
});

// ─── Conditional update pattern ────────────────────────────────────────

test("update_task throws when no fields provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task");
  assert.match(segment, /No fields to update/, "Should reject empty updates");
});

test("update_project throws when no fields provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_project");
  assert.match(segment, /No fields to update/, "Should reject empty updates");
});

test("update_task_note throws when no fields provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "update_task_note");
  assert.match(segment, /No fields to update/, "Should reject empty updates");
});

test("bulk_update_tasks throws when no fields provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "bulk_update_tasks");
  assert.match(segment, /No fields to update/, "Should reject empty updates");
});

// ─── db_stats ──────────────────────────────────────────────────────────

test("db_stats calls db_overview RPC", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /supabase\.rpc\("db_overview"\)/, "Should call db_overview RPC");
});

test("db_stats reports stale in_progress tasks", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /in_progress for >7 days/, "Should flag stale tasks");
});

test("db_stats reports orphaned task notes", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /orphaned task note/, "Should flag orphaned notes");
});

test("db_stats reports duplicate personal_info keys", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /duplicate personal_info key/, "Should flag duplicate keys");
});

test("db_stats shows 'No issues detected' when clean", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /No issues detected/, "Should show clean state");
});

// ─── Default limits ────────────────────────────────────────────────────

test("search_thoughts defaults to limit 10 and threshold 0.5", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_thoughts");
  assert.match(segment, /limit \?\? 10/, "Should default limit to 10");
  assert.match(segment, /threshold \?\? 0\.5/, "Should default threshold to 0.5");
});

test("list_tasks defaults to limit 20", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_tasks", 4000);
  assert.match(segment, /limit \?\? 20/, "Should default limit to 20");
});

test("get_project_bundle defaults task_limit to 25 and note_limit to 15", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_project_bundle", 4000);
  assert.match(segment, /task_limit \?\? 25/, "Should default task_limit to 25");
  assert.match(segment, /note_limit \?\? 15/, "Should default note_limit to 15");
});

test("get_task_bundle defaults note_limit to 10", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_task_bundle");
  assert.match(segment, /note_limit \?\? 10/, "Should default note_limit to 10");
});

// ─── Cross-reference tools ─────────────────────────────────────────────

test("connect_thought_to_info requires either thought_id or query", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "connect_thought_to_info", 4000);
  assert.match(segment, /Either thought_id or query is required/, "Should require one of thought_id or query");
});

test("connect_info_to_thoughts normalizes key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "connect_info_to_thoughts");
  assert.match(segment, /key\.toLowerCase\(\)\.trim\(\)/, "Should normalize key");
});

test("connect_thought_to_info falls back to search when no thought_id", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "connect_thought_to_info", 4000);
  assert.match(segment, /searchThoughts\(supabase, query, 1/, "Should search for thought when only query provided");
});

// ─── set_personal_info embeds key:value for semantic search ────────────

test("set_personal_info embeds concatenated key:value", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "set_personal_info");
  assert.match(segment, /`\$\{key\}: \$\{value\}`/, "Should embed key:value for semantic search");
});

// ─── get_task fetches associated notes ─────────────────────────────────

test("get_task fetches associated task notes", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_task", 3500);
  assert.match(segment, /task_notes/, "Should query task_notes table");
  assert.match(segment, /eq\("task_id", task_id\)/, "Should filter notes by task_id");
});

// ─── search uses ilike pattern matching ────────────────────────────────

test("search_tasks uses ilike pattern for title, description, status, priority", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_tasks");
  assert.match(segment, /title\.ilike/, "Should search title");
  assert.match(segment, /description\.ilike/, "Should search description");
});

test("search_projects uses ilike for name, description, repo_url", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_projects");
  assert.match(segment, /name\.ilike/, "Should search name");
  assert.match(segment, /description\.ilike/, "Should search description");
  assert.match(segment, /repo_url\.ilike/, "Should search repo_url");
});

test("search_task_notes uses ilike for content and type", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "search_task_notes");
  assert.match(segment, /content\.ilike/, "Should search content");
  assert.match(segment, /type\.ilike/, "Should search type");
});
