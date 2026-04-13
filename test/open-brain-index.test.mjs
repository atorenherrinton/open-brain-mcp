import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const indexPath = path.join(repoRoot, "supabase", "functions", "open-brain", "index.ts");

async function readIndex() {
  return await fs.readFile(indexPath, "utf8");
}

function sliceFrom(content, needle, length = 2500) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `Expected to find substring: ${needle}`);
  return content.slice(idx, idx + length);
}

test("registers delete_task tool", async () => {
  const content = await readIndex();
  assert.match(content, /registerTool\(\s*"delete_task"/);
});

test("tool manifest matches snapshot", async () => {
  const content = await readIndex();
  const tools = [...content.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tools, [
    "version",
    "whoami",
    "server_info",
    "health",
    "db_stats",
    "search_thoughts",
    "list_thoughts",
    "thought_stats",
    "capture_thought",
    "delete_thought",
    "prune_thoughts",
    "set_personal_info",
    "get_personal_info",
    "search_personal_info",
    "list_personal_info",
    "delete_personal_info",
    "get_project_bundle",
    "create_project",
    "get_project",
    "update_project",
    "list_projects",
    "search_projects",
    "create_task",
    "get_task",
    "get_task_bundle",
    "update_task",
    "delete_task",
    "bulk_delete_tasks",
    "bulk_update_tasks",
    "list_tasks",
    "search_tasks",
    "add_task_note",
    "list_task_notes",
    "update_task_note",
    "delete_task_note",
    "search_task_notes",
    "connect_info_to_thoughts",
    "connect_thought_to_info",
  ]);
  assert.equal(new Set(tools).size, tools.length, "Expected no duplicate tool registrations");
});

test("TASK_STATUSES includes archived", async () => {
  const content = await readIndex();
  const segment = sliceFrom(content, "const TASK_STATUSES");
  assert.match(segment, /\[\s*"todo"\s*,\s*"in_progress"\s*,\s*"done"\s*,\s*"archived"\s*\]\s+as const/);
});

test("list_tasks supports include_archived and filters archived by default", async () => {
  const content = await readIndex();
  const segment = sliceFrom(content, 'registerTool(\n    "list_tasks"', 4000);
  assert.match(segment, /include_archived:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(segment, /query\s*=\s*query\.neq\("status",\s*"archived"\)/);
});

test("search_tasks supports include_archived and filters archived by default", async () => {
  const content = await readIndex();
  const segment = sliceFrom(content, 'registerTool(\n    "search_tasks"', 4000);
  assert.match(segment, /include_archived:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(segment, /q\s*=\s*q\.neq\("status",\s*"archived"\)/);
});

test("capture_thought normalizes topics to lowercase tags", async () => {
  const content = await readIndex();
  assert.match(content, /from "\.\/utils\.mjs"/);

  const captureSegment = sliceFrom(content, "async function captureThought", 2500);
  assert.match(captureSegment, /const normalizedTopics = normalizeTopicTags\(/);
  assert.match(captureSegment, /topics:\s*normalizedTopics/);
});

test("HTTP routes include expected action handlers", async () => {
  const content = await readIndex();
  for (const fragment of [
    ".well-known/oauth-protected-resource",
    ".well-known/oauth-authorization-server",
    "authorize",
    "oauth/token",
    "handleMcpRequest",
    "action === \"health\"",
    "action === \"capture\"",
    "action === \"search\"",
    "action === \"thoughts\"",
    "action === \"stats\"",
    "Not found",
  ]) {
    assert.ok(content.includes(fragment), `Expected index.ts to include route fragment: ${fragment}`);
  }
});
