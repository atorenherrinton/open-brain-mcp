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

// ─── NOT_FOUND handling ────────────────────────────────────────────────

test("get_personal_info returns message when key not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_personal_info");
  assert.match(segment, /No personal info found for/, "Should return not-found message");
});

// ─── Job search tools ─────────────────────────────────────────────────

test("get_job_profile returns not-set message when missing", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_job_profile");
  assert.match(segment, /No job_search\.profile set/, "Should return not-set message");
});

test("get_job_profile reads from job_search.profile key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_job_profile");
  assert.match(segment, /job_search\.profile/, "Should read job_search.profile key");
});

test("get_answer_bank returns not-set message when missing", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_answer_bank");
  assert.match(segment, /No job_search\.answer_bank set/, "Should return not-set message");
});

test("get_answer_bank reads from job_search.answer_bank key", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "get_answer_bank");
  assert.match(segment, /job_search\.answer_bank/, "Should read job_search.answer_bank key");
});

test("add_answer requires non-empty category, question_type, id, and text", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_answer");
  assert.match(segment, /category, question_type, id, and text are required/, "Should validate required fields");
});

test("add_answer rejects duplicate ids within the same question_type", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_answer");
  assert.match(segment, /already exists in/, "Should reject duplicate ids");
});

test("add_answer rejects unknown answer_bank category", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_answer");
  assert.match(segment, /Unknown answer_bank category/, "Should reject unknown categories");
});

test("add_answer defaults approved to false and source to drafted_by_assistant", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_answer");
  assert.match(segment, /approved \?\? false/, "Should default approved to false");
  assert.match(segment, /"drafted_by_assistant"/, "Should default source to drafted_by_assistant");
});

test("add_answer bumps answer_bank metadata.updated_at", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "add_answer");
  assert.match(segment, /metadata\.updated_at = new Date\(\)/, "Should update metadata timestamp");
});

test("readJobSearchBlob throws on invalid JSON", async () => {
  const content = await readIndex();
  const segment = sliceFrom(content, "async function readJobSearchBlob");
  assert.match(segment, /is not valid JSON/, "Should throw on bad JSON");
});

test("writeJobSearchBlob uses job_search category and regenerates embedding", async () => {
  const content = await readIndex();
  const segment = sliceFrom(content, "async function writeJobSearchBlob");
  assert.match(segment, /p_category: "job_search"/, "Should write under job_search category");
  assert.match(segment, /getEmbedding/, "Should regenerate embedding on write");
});

// ─── Empty result handling ─────────────────────────────────────────────

test("list_personal_info handles both category and no-category empty states", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "list_personal_info");
  assert.match(segment, /No personal info in category/, "Should handle filtered empty");
  assert.match(segment, /No personal info stored yet/, "Should handle unfiltered empty");
});

// ─── Conditional update pattern ────────────────────────────────────────

// ─── db_stats ──────────────────────────────────────────────────────────

test("db_stats calls db_overview RPC", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "db_stats");
  assert.match(segment, /supabase\.rpc\("db_overview"\)/, "Should call db_overview RPC");
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

// ─── search uses ilike pattern matching ────────────────────────────────

// ─── delete_thought ────────────────────────────────────────────────────

test("delete_thought returns message when thought not found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_thought");
  assert.match(segment, /No thought found with ID/, "Should return not-found message");
});

test("delete_thought uses maybeSingle for safe deletion", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_thought");
  assert.match(segment, /maybeSingle/, "Should use maybeSingle");
});

test("delete_thought shows snippet in confirmation", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "delete_thought");
  assert.match(segment, /makeSnippet/, "Should show content snippet in confirmation");
});

// ─── prune_thoughts ────────────────────────────────────────────────────

test("prune_thoughts calculates cutoff date from older_than_days", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /older_than_days \* 24 \* 60 \* 60 \* 1000/, "Should calculate cutoff in ms");
});

test("prune_thoughts supports dry_run mode", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /dry_run/, "Should support dry_run");
  assert.match(segment, /Dry run:/, "Should label dry run output");
});

test("prune_thoughts filters by type when provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /metadata->>type/, "Should filter by metadata type");
});

test("prune_thoughts filters by topic when provided", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /\.contains\("metadata"/, "Should filter by topic via contains");
});

test("prune_thoughts returns message when no candidates found", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /No thoughts found older than/, "Should return empty message");
});

test("prune_thoughts limits dry_run preview to 10 items", async () => {
  const content = await readIndex();
  const segment = sliceTool(content, "prune_thoughts", 4000);
  assert.match(segment, /\.slice\(0, 10\)/, "Should limit preview to 10");
});
