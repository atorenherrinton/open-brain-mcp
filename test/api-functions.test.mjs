/**
 * Structural tests for API functions (getEmbedding, extractMetadata)
 * and MCP tool handler invariants.
 *
 * Since index.ts uses Deno imports, these tests validate function
 * structure, API contract shapes, and behavioral invariants via
 * source analysis.
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

function sliceFrom(content, needle, length = 3000) {
  const idx = content.indexOf(needle);
  assert.ok(idx !== -1, `Expected to find: ${needle}`);
  return content.slice(idx, idx + length);
}

// ─── getEmbedding ──────────────────────────────────────────────────────

test("getEmbedding calls OpenRouter embeddings endpoint", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function getEmbedding(", 1000);
  assert.match(fn, /OPENROUTER_BASE.*\/embeddings/, "Should call /embeddings endpoint");
});

test("getEmbedding uses text-embedding-3-small model", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function getEmbedding(", 1000);
  assert.match(fn, /text-embedding-3-small/, "Should use text-embedding-3-small model");
});

test("getEmbedding sends Authorization header with API key", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function getEmbedding(", 1000);
  assert.match(fn, /Authorization.*Bearer.*OPENROUTER_API_KEY/, "Should send Bearer token from env");
});

test("getEmbedding throws on non-ok response", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function getEmbedding(", 1000);
  assert.match(fn, /if \(!res\.ok\)/, "Should check response status");
  assert.match(fn, /throw new Error.*Embedding failed/, "Should throw descriptive error");
});

test("getEmbedding returns embedding array from response", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function getEmbedding(", 1000);
  assert.match(fn, /data\.data\[0\]\.embedding/, "Should extract embedding from response");
});

// ─── extractMetadata ───────────────────────────────────────────────────

test("extractMetadata calls OpenRouter chat completions endpoint", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  assert.match(fn, /OPENROUTER_BASE.*\/chat\/completions/, "Should call /chat/completions endpoint");
});

test("extractMetadata uses gpt-4o-mini model", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  assert.match(fn, /gpt-4o-mini/, "Should use gpt-4o-mini model");
});

test("extractMetadata requests JSON response format", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  assert.match(fn, /json_object/, "Should request JSON response format");
});

test("extractMetadata extracts expected fields", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  for (const field of ["people", "action_items", "dates_mentioned", "topics", "type"]) {
    assert.ok(fn.includes(`"${field}"`), `Should extract ${field} field`);
  }
});

test("extractMetadata returns fallback on parse failure", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  assert.match(fn, /uncategorized/, "Should fall back to 'uncategorized' topic");
  assert.match(fn, /observation/, "Should fall back to 'observation' type");
});

test("extractMetadata defines valid type enum in prompt", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function extractMetadata(", 2000);
  for (const type of ["observation", "task", "idea", "reference", "person_note"]) {
    assert.ok(fn.includes(type), `System prompt should mention type: ${type}`);
  }
});

// ─── captureThought integration ────────────────────────────────────────

test("captureThought calls both getEmbedding and extractMetadata", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /getEmbedding\(/, "Should call getEmbedding");
  assert.match(fn, /extractMetadata\(/, "Should call extractMetadata");
});

test("captureThought normalizes content before processing", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /normalizeContent\(/, "Should normalize content");
});

test("captureThought normalizes topic tags to lowercase", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /normalizeTopicTags\(/, "Should normalize topic tags");
});

test("captureThought enforces max character limit", async () => {
  const content = await readIndex();
  assert.match(content, /MAX_THOUGHT_CHARS/, "Should define MAX_THOUGHT_CHARS constant");
  const fn = sliceFrom(content, "async function captureThought(", 2500);
  assert.match(fn, /MAX_THOUGHT_CHARS/, "Should check character limit in captureThought");
});

// ─── MCP tool handler invariants ───────────────────────────────────────

test("all tool handlers use normalizeToolResult or normalizeToolError", async () => {
  const content = await readIndex();
  // registerTool wrapper should apply normalization
  const wrapper = sliceFrom(content, "const registerTool = ", 800);
  assert.match(wrapper, /normalizeToolResult/, "registerTool wrapper should normalize results");
  assert.match(wrapper, /normalizeToolError/, "registerTool wrapper should normalize errors");
});

test("update_task only updates provided fields", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"update_task"', 2000);
  // Should build update object conditionally using !== undefined checks
  assert.match(fn, /title !== undefined/, "Should conditionally include title");
  assert.match(fn, /description !== undefined/, "Should conditionally include description");
  assert.match(fn, /status !== undefined/, "Should conditionally include status");
});

test("delete_task requires confirmation via task_id", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"delete_task"', 1500);
  assert.match(fn, /task_id.*z\.string\(\)/, "Should require task_id as string");
});

test("bulk_delete_tasks requires array of task_ids", async () => {
  const content = await readIndex();
  const fn = sliceFrom(content, '"bulk_delete_tasks"', 1500);
  assert.match(fn, /task_ids.*z\.array/, "Should require task_ids as array");
});

test("search_thoughts uses vector similarity via searchThoughts helper", async () => {
  const content = await readIndex();
  // The tool handler calls searchThoughts(), which internally uses getEmbedding + match_thoughts
  const fn = sliceFrom(content, '"search_thoughts"', 3000);
  assert.match(fn, /searchThoughts/, "Should call searchThoughts helper");

  // Verify the helper itself uses embedding-based search
  const helper = sliceFrom(content, "async function searchThoughts(", 1000);
  assert.match(helper, /getEmbedding/, "searchThoughts should embed query");
  assert.match(helper, /match_thoughts/, "searchThoughts should call match_thoughts RPC");
});

test("task statuses include archived", async () => {
  const content = await readIndex();
  assert.match(content, /TASK_STATUSES.*archived/s, "TASK_STATUSES should include archived");
});

test("task priorities include low, medium, high", async () => {
  const content = await readIndex();
  assert.match(content, /TASK_PRIORITIES.*low.*medium.*high/s, "Should define all priority levels");
});
