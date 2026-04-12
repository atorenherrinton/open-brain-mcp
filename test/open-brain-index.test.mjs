import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
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
  assert.match(content, /function normalizeTopicTags\(/);
  assert.match(content, /\.toLowerCase\(\)/);

  const captureSegment = sliceFrom(content, "async function captureThought", 2500);
  assert.match(captureSegment, /const normalizedTopics = normalizeTopicTags\(/);
  assert.match(captureSegment, /topics:\s*normalizedTopics/);
});

